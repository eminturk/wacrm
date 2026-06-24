// ============================================================
// API key store — the *auth-path* data access for public API keys.
//
// Migrated off Supabase to Drizzle. Access control is enforced in the
// application layer (RLS removed): the hash is the only credential, so
// `findActiveKeyByHash` is the moment that establishes the caller's
// account. Keeping this surface tiny and read-only makes it easy to
// audit.
// ============================================================

import { eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { apiKeys, accounts } from '@/lib/db/schema';

/** Shape of an `api_keys` row as the auth path consumes it. */
export interface ApiKeyRow {
  id: string;
  account_id: string;
  created_by: string | null;
  name: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * Look up an *active* key by its SHA-256 hash. Returns null if no row
 * matches, or if the matching row is revoked or expired.
 */
export async function findActiveKeyByHash(
  hash: string
): Promise<ApiKeyRow | null> {
  let rows;
  try {
    rows = await db
      .select({
        id: apiKeys.id,
        accountId: apiKeys.accountId,
        createdBy: apiKeys.createdBy,
        name: apiKeys.name,
        scopes: apiKeys.scopes,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hash))
      .limit(1);
  } catch (err) {
    console.error('[api-keys/store] lookup error:', err);
    return null;
  }

  const data = rows[0];
  if (!data) return null;

  // Liveness checks in JS so the failure modes are explicit.
  if (data.revokedAt) return null;
  if (data.expiresAt && new Date(data.expiresAt).getTime() <= Date.now()) {
    return null;
  }

  return {
    id: data.id,
    account_id: data.accountId,
    created_by: data.createdBy,
    name: data.name,
    scopes: data.scopes ?? [],
    expires_at: data.expiresAt ? data.expiresAt.toISOString() : null,
    revoked_at: data.revokedAt ? data.revokedAt.toISOString() : null,
  };
}

/**
 * Fetch the account name for a resolved key, so `/api/v1/me` and any
 * future endpoint can echo it without a second round trip in the route.
 */
export async function getAccountName(
  accountId: string
): Promise<string | null> {
  const rows = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return rows[0]?.name ?? null;
}

/**
 * Best-effort `last_used_at` bump. Fire-and-forget from the auth path.
 */
export function touchLastUsed(id: string): void {
  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, id))
    .catch((err) => {
      console.warn('[api-keys/store] last_used_at bump failed:', err);
    });
}
