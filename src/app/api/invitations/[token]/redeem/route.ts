/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================
// POST /api/invitations/[token]/redeem
//
// Authenticated. Caller atomically moves from their personal
// account (created at signup) to the inviter's account with the
// invite's role. Mirrors the SECURITY DEFINER invitation function
// from migration 019, but passes the authenticated app-session user
// explicitly because standalone Postgres has no auth.uid().
//
// Refusal contract
//   - 42501 → 401 (caller not authenticated)
//   - 22023 → 400 (invitation not_found / used / expired)
//   - 23505 → 409 (caller's account already has data /
//     they're already in this or another shared account)
//
// Rate limit (per IP) is the same shape as peek but tighter —
// a successful redeem changes data, and the data-loss guard makes
// brute-force retries pointless past a few attempts.
// ============================================================

import { NextResponse } from "next/server";

import { hashInviteToken } from "@/lib/auth/invitations";
import { getSession } from "@/lib/auth/session";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { db, sql } from "@/lib/db";

type DbRow = Record<string, any>;

class InvitationError extends Error {
  constructor(readonly code: "42501" | "22023" | "23505", message: string) {
    super(message);
  }
}

function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

function invitationErrorToResponse(err: unknown): NextResponse {
  if (err instanceof InvitationError) {
    if (err.code === "42501") {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    if (err.code === "22023") {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err.code === "23505") {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
  }
  console.error("[redeem] unexpected invitation error:", err);
  return NextResponse.json(
    { error: "Failed to redeem invitation" },
    { status: 500 },
  );
}

async function redeemInvitation(tokenHash: string, callerId: string): Promise<string> {
  return db.transaction(async (tx) => {
    const inviteRows = (await tx.execute(sql`
      SELECT *
      FROM account_invitations
      WHERE token_hash = ${tokenHash}
      FOR UPDATE
    `)) as DbRow[];
    const invite = inviteRows[0];

    if (!invite) {
      throw new InvitationError("22023", "Invitation not found");
    }
    if (invite.accepted_at !== null) {
      throw new InvitationError("22023", "Invitation has already been redeemed");
    }
    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      throw new InvitationError("22023", "Invitation has expired");
    }

    const accountRows = (await tx.execute(sql`
      SELECT p.account_id, a.owner_user_id
      FROM profiles p
      JOIN accounts a ON a.id = p.account_id
      WHERE p.user_id = ${callerId}
      LIMIT 1
    `)) as DbRow[];
    const current = accountRows[0];

    if (!current?.account_id) {
      throw new InvitationError("42501", "Caller has no profile");
    }

    if (current.account_id === invite.account_id) {
      throw new InvitationError("23505", "You are already a member of this account");
    }

    if (current.owner_user_id !== callerId) {
      throw new InvitationError(
        "23505",
        "You are already in a shared account; sign up with a different email to join this one",
      );
    }

    const dataRows = (await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM contacts WHERE account_id = ${current.account_id}
        UNION ALL SELECT 1 FROM conversations WHERE account_id = ${current.account_id}
        UNION ALL SELECT 1 FROM broadcasts WHERE account_id = ${current.account_id}
        UNION ALL SELECT 1 FROM automations WHERE account_id = ${current.account_id}
        UNION ALL SELECT 1 FROM flows WHERE account_id = ${current.account_id}
        UNION ALL SELECT 1 FROM pipelines WHERE account_id = ${current.account_id}
        UNION ALL SELECT 1 FROM message_templates WHERE account_id = ${current.account_id}
        UNION ALL SELECT 1 FROM tags WHERE account_id = ${current.account_id}
        UNION ALL SELECT 1 FROM custom_fields WHERE account_id = ${current.account_id}
        UNION ALL SELECT 1 FROM contact_notes WHERE account_id = ${current.account_id}
        UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = ${current.account_id}
        LIMIT 1
      ) AS has_data
    `)) as DbRow[];

    if (dataRows[0]?.has_data) {
      throw new InvitationError(
        "23505",
        "Your account already contains data; sign up with a different email to join this one",
      );
    }

    await tx.execute(sql`
      UPDATE profiles
      SET account_id = ${invite.account_id},
          account_role = ${invite.role},
          updated_at = NOW()
      WHERE user_id = ${callerId}
    `);

    await tx.execute(sql`
      UPDATE account_invitations
      SET accepted_at = NOW(),
          accepted_by_user_id = ${callerId}
      WHERE id = ${invite.id}
    `);

    await tx.execute(sql`
      DELETE FROM accounts
      WHERE id = ${current.account_id}
    `);

    return invite.account_id as string;
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(`redeem:${ip}`, RATE_LIMITS.invitationRedeem);
  if (!limit.success) return rateLimitResponse(limit);

  const { token } = await params;
  if (!token || typeof token !== "string") {
    return NextResponse.json(
      { error: "Missing invitation token" },
      { status: 400 },
    );
  }

  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const accountId = await redeemInvitation(hashInviteToken(token), user.id);
    return NextResponse.json({ ok: true, accountId });
  } catch (error) {
    return invitationErrorToResponse(error);
  }
}
