// ============================================================
// /api/account/members/[userId]
//
//   PATCH  — change a member's role.   Admin+.
//   DELETE — remove a member.          Admin+.
//
// Both delegate to SECURITY DEFINER RPCs from migration 018:
//   - set_member_role(p_user_id, p_new_role)
//   - remove_account_member(p_user_id)
//
// The RPCs do the *real* authorisation work — caller must be
// admin+, target must be in caller's account, target can't be the
// owner, can't be self. The TS layer here only forwards the call
// and maps Postgres SQLSTATEs back to HTTP statuses.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { sql } from "@/lib/db";
import { isAccountRole } from "@/lib/auth/roles";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

// Map known SQLSTATEs raised by the RPCs (see migration 027) onto HTTP
// statuses. The postgres-js driver throws errors carrying the SQLSTATE
// on `.code` and the RAISE message on `.message`.
function rpcErrorToResponse(err: unknown): NextResponse {
  const e = err as { code?: string; message?: string };
  if (e?.code === "42501") {
    return NextResponse.json({ error: e.message }, { status: 403 });
  }
  if (e?.code === "22023") {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  console.error("[members route] unexpected RPC error:", err);
  return NextResponse.json(
    { error: "Failed to update member" },
    { status: 500 },
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberRole:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const body = (await request.json().catch(() => null)) as
      | { role?: unknown }
      | null;
    const role = body?.role;

    if (!isAccountRole(role)) {
      return NextResponse.json(
        { error: "'role' must be one of owner, admin, agent, viewer" },
        { status: 400 },
      );
    }

    // The RPC blocks promotion to / demotion from owner, but
    // surface the friendlier 400 before crossing the wire too.
    if (role === "owner") {
      return NextResponse.json(
        {
          error:
            "Use POST /api/account/transfer-ownership to promote a member to owner",
        },
        { status: 400 },
      );
    }

    try {
      await ctx.db.execute(
        sql`SELECT set_member_role(${ctx.userId}::uuid, ${userId}::uuid, ${role}::account_role_enum)`,
      );
    } catch (error) {
      return rpcErrorToResponse(error);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberRemove:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    let newPersonalAccountId: unknown = null;
    try {
      const rows = await ctx.db.execute(
        sql`SELECT remove_account_member(${ctx.userId}::uuid, ${userId}::uuid) AS new_account_id`,
      );
      newPersonalAccountId =
        (rows as unknown as Array<{ new_account_id: string }>)[0]
          ?.new_account_id ?? null;
    } catch (error) {
      return rpcErrorToResponse(error);
    }

    return NextResponse.json({ ok: true, newPersonalAccountId });
  } catch (err) {
    return toErrorResponse(err);
  }
}
