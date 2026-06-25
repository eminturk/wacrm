// ============================================================
// Server-side data access — compatibility shim.
//
// The app has migrated off Supabase/PostgREST to plain PostgreSQL via
// Drizzle. This module used to return a Supabase SSR client; it now
// re-exports the Drizzle `db` handle (and `sql`) so server code has a
// single import for database access.
//
//   import { db, sql } from '@/lib/supabase/server'
//
// New code should import from '@/lib/db' directly. This re-export
// exists to keep the historical import path working during the
// migration.
// ============================================================

export { db, sql, schema } from '@/lib/db'
export { getSession } from '@/lib/auth/session'
