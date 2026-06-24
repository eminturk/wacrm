// ============================================================
// Admin database handle.
//
// Historically (under Supabase) there were two clients: an RLS-scoped
// "anon" client tied to the user's session, and a "service-role"
// client that bypassed row-level security for engine/webhook work.
//
// We no longer use Postgres RLS — access control is enforced in the
// application layer by always filtering queries by `account_id`. So
// the "admin" handle is simply the same Drizzle connection as
// `@/lib/db`. This module exists to preserve the call sites that
// imported a privileged client and to document that callers using
// `adminDb` are responsible for their own account scoping.
// ============================================================

import { db } from './index'

/**
 * Privileged database handle. Identical connection to `db` — there is
 * no separate service role because RLS has been removed. Callers MUST
 * scope every query by `account_id` themselves.
 */
export const adminDb = db

export { sql } from 'drizzle-orm'
export * as schema from './schema'
