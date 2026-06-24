// ============================================================
// Server-side account context — for API routes and server
// components. Reads the caller's profile + account in one round
// trip and verifies role on demand.
//
// IMPORTANT: this module is server-only. It imports the session
// helper (`@/lib/auth/session`), which reads `next/headers` cookies.
// Importing it from a client component will fail at build time.
//
// Calling convention
// ------------------
//   try {
//     const ctx = await requireRole("admin");
//     // ctx.db       — the Drizzle handle
//     // ctx.userId   — the caller's user id
//     // ctx.accountId / ctx.role / ctx.account
//   } catch (err) {
//     return toErrorResponse(err);
//   }
// ============================================================

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { profiles, accounts } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { hasMinRole, isAccountRole, type AccountRole } from "./roles";

// ------------------------------------------------------------
// Errors
// ------------------------------------------------------------

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Convert one of the typed errors above (or anything else) into a
 * `NextResponse`. Unknown errors collapse to 500 with the generic
 * message — we never leak `err.message` for non-classified errors.
 */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[toErrorResponse] uncategorized error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

// ------------------------------------------------------------
// Account context
// ------------------------------------------------------------

export interface AccountContext {
  /** Drizzle database handle. Scope every query by `accountId`. */
  db: typeof db;
  /** The caller's user id. Always defined when this resolves. */
  userId: string;
  /** Caller's account_id from their profile row. */
  accountId: string;
  /** Caller's role within their account. */
  role: AccountRole;
  /** Lightweight account meta — id + name. */
  account: { id: string; name: string };
}

/**
 * Resolve the caller's user + account + role in one round trip.
 *
 * Throws `UnauthorizedError` if there's no valid session.
 * Throws `ForbiddenError` if the profile is missing account fields.
 */
export async function getCurrentAccount(): Promise<AccountContext> {
  const sessionUser = await getSession();
  if (!sessionUser) {
    throw new UnauthorizedError();
  }

  const rows = await db
    .select({
      accountId: profiles.accountId,
      accountRole: profiles.accountRole,
      accountIdJoined: accounts.id,
      accountName: accounts.name,
    })
    .from(profiles)
    .innerJoin(accounts, eq(profiles.accountId, accounts.id))
    .where(eq(profiles.userId, sessionUser.id))
    .limit(1);

  const data = rows[0];
  if (!data || !data.accountId || !data.accountRole) {
    throw new ForbiddenError("Profile is not linked to an account");
  }
  if (!isAccountRole(data.accountRole)) {
    throw new ForbiddenError(`Unknown account role: ${data.accountRole}`);
  }

  return {
    db,
    userId: sessionUser.id,
    accountId: data.accountId,
    role: data.accountRole,
    account: { id: data.accountIdJoined, name: data.accountName },
  };
}

/**
 * Resolve the caller's account context and enforce a minimum role.
 */
export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      `This action requires the '${min}' role or higher`,
    );
  }
  return ctx;
}
