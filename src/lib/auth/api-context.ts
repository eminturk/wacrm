// ============================================================
// Public API authentication — resolve a request's API key into an
// account context.
//
// This is the machine-to-machine counterpart of `getCurrentAccount`
// (cookie session → account). The public API authenticates a caller
// via `Authorization: ******
//
// Calling convention — every `/api/v1` route does:
//
//   try {
//     const ctx = await requireApiKey(request, "messages:send");
//     // ctx.db         — the Drizzle handle
//     // ctx.accountId  — the key's account; scope every query by it
//     // ctx.scopes     — granted scopes
//     // ctx.keyId      — for logging / the rate-limit bucket
//   } catch (err) {
//     return toApiErrorResponse(err);
//   }
//
// There is no Postgres RLS anymore: the key lookup establishes the
// account, and from there every downstream query MUST be explicitly
// filtered by `ctx.accountId`.
// ============================================================

import { db } from '@/lib/db';
import { findActiveKeyByHash, touchLastUsed } from '@/lib/api-keys/store';
import { hashApiKey, looksLikeApiKey } from '@/lib/api-keys/keys';
import { hasScope, type ApiScope } from '@/lib/api-keys/scopes';
import { forbidden, rateLimited, unauthorized } from '@/lib/api/v1/respond';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

export interface ApiKeyContext {
  /** Discriminant — lets shared logic tell key auth from cookie auth. */
  authType: 'api_key';
  /** Drizzle database handle. Scope every query by `accountId`. */
  db: typeof db;
  /** The account this key belongs to. */
  accountId: string;
  /** The key row id — for audit logging and the rate-limit bucket. */
  keyId: string;
  /** Scopes granted to this key. */
  scopes: string[];
  /** Who minted the key (null if that user was later removed). */
  createdBy: string | null;
}

/**
 * Extract the bearer token from the `Authorization` header.
 */
function extractKey(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const value = header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : header.trim();
  return value.length > 0 ? value : null;
}

/**
 * Authenticate a public-API request and (optionally) enforce a single
 * scope. Throws an `ApiError` on failure (401 / 403 / 429). On
 * success, bumps `last_used_at` (fire-and-forget) and returns the
 * account context.
 */
export async function requireApiKey(
  request: Request,
  scope?: ApiScope
): Promise<ApiKeyContext> {
  const presented = extractKey(request);
  if (!presented || !looksLikeApiKey(presented)) {
    throw unauthorized();
  }

  const row = await findActiveKeyByHash(hashApiKey(presented));
  if (!row) {
    throw unauthorized();
  }

  // Rate-limit per key, before the scope check.
  const limit = await checkRateLimit(`apikey:${row.id}`, RATE_LIMITS.publicApi);
  if (!limit.success) {
    throw rateLimited(limit);
  }

  if (scope && !hasScope(row.scopes, scope)) {
    throw forbidden(`This API key is missing the '${scope}' scope`);
  }

  touchLastUsed(row.id);

  return {
    authType: 'api_key',
    db,
    accountId: row.account_id,
    keyId: row.id,
    scopes: row.scopes,
    createdBy: row.created_by,
  };
}
