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
import { headers } from "next/headers";

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
// IP allowlist helpers
// ------------------------------------------------------------

/**
 * Return the client IP from Next.js request headers (server context).
 * Prefers X-Forwarded-For (set by reverse proxies / CDNs).
 */
async function resolveClientIp(): Promise<string | null> {
  try {
    const hdrs = await headers();
    const xff = hdrs.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
    return hdrs.get("x-real-ip");
  } catch {
    return null;
  }
}

/**
 * Tiny CIDR match that handles IPv4 /prefix notation and plain IPs.
 * We intentionally keep this dependency-free; the spec only requires
 * per-account IP whitelisting, not full CIDR routing.
 */
function ipMatchesCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes("/")) {
    return ip === cidr;
  }
  const [network, prefixStr] = cidr.split("/");
  const prefix = parseInt(prefixStr, 10);
  if (isNaN(prefix)) return false;
  const ipParts = ip.split(".").map(Number);
  const netParts = network.split(".").map(Number);
  if (ipParts.length !== 4 || netParts.length !== 4) return false;
  const mask = ~((1 << (32 - prefix)) - 1) >>> 0;
  const ipNum =
    ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
  const netNum =
    ((netParts[0] << 24) | (netParts[1] << 16) | (netParts[2] << 8) | netParts[3]) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

/**
 * Check whether `ip` is permitted by the account's `ip_allowlist`.
 * An empty list means "allow all". Returns true when allowed.
 */
export function isIpAllowed(ip: string | null, allowlist: string[]): boolean {
  if (!allowlist || allowlist.length === 0) return true; // open
  if (!ip) return false; // can't verify; deny by default
  return allowlist.some((entry) => ipMatchesCidr(ip, entry.trim()));
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
 * Throws `ForbiddenError` if the profile is missing account fields,
 *   or if the account has an IP allowlist and the caller's IP is not
 *   in it ("IP kısıtlaması").
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
      ipAllowlist: accounts.ipAllowlist,
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

  // ---- IP allowlist enforcement ----
  const allowlist = data.ipAllowlist ?? [];
  if (allowlist.length > 0) {
    const clientIp = await resolveClientIp();
    if (!isIpAllowed(clientIp, allowlist)) {
      throw new ForbiddenError("Access denied: your IP address is not in the allowlist");
    }
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
