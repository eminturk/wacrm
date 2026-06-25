// ============================================================
// Flows engine database handle.
//
// Migrated off Supabase: this used to return a service-role Supabase
// client. It now re-exports the Drizzle admin handle. The function
// name `supabaseAdmin` is preserved so existing call sites keep
// working, but it returns the Drizzle `db` — callers MUST scope every
// query by `account_id` (RLS has been removed).
// ============================================================

export { adminDb as db } from '@/lib/db/admin'
export { sql, schema } from '@/lib/db/admin'

import { adminDb } from '@/lib/db/admin'

/** @deprecated Returns the Drizzle admin handle. Prefer importing `db`. */
export function supabaseAdmin() {
  return adminDb
}
