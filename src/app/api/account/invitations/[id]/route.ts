// ============================================================
// DELETE /api/account/invitations/[id]
//
// Admin+. Revokes a pending invitation by id. RLS on
// `account_invitations` already restricts the DELETE to admins
// of the inviting account; we lean on it and skip the explicit
// ownership check.
//
// We intentionally delete the row outright rather than soft-
// deleting (a "revoked_at" flag). Once revoked, an invite is
// dead forever — there's no UX where a former invite should be
// listed; the plaintext token is gone too. Hard delete keeps
// the table small.
// ============================================================

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { accountInvitations } from "@/lib/db/schema";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:inviteRevoke:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    // Scope the DELETE to invites in the caller's account (there is no
    // RLS anymore). A cross-account attempt surfaces as a 0-row delete.
    let deleted;
    try {
      deleted = await ctx.db
        .delete(accountInvitations)
        .where(
          and(
            eq(accountInvitations.id, id),
            eq(accountInvitations.accountId, ctx.accountId),
          ),
        )
        .returning({ id: accountInvitations.id });
    } catch (error) {
      console.error("[DELETE /api/account/invitations/[id]] error:", error);
      return NextResponse.json(
        { error: "Failed to revoke invitation" },
        { status: 500 },
      );
    }

    if (deleted.length === 0) {
      // Either the id doesn't exist or it's a different account. 404
      // either way — surfacing "exists but not yours" would leak
      // existence.
      return NextResponse.json(
        { error: "Invitation not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
