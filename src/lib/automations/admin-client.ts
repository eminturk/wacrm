// ============================================================
// Automation engine database handle.
//
// Migrated off Supabase: re-exports the Drizzle admin handle. See
// src/lib/flows/admin-client.ts for the rationale. Callers MUST scope
// every query by `account_id`.
// ============================================================

export { adminDb as db } from '@/lib/db/admin'
export { sql, schema } from '@/lib/db/admin'

import { adminDb } from '@/lib/db/admin'

/** @deprecated Returns the Drizzle admin handle. Prefer importing `db`. */
export function supabaseAdmin() {
  return adminDb
}
