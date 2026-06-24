// ============================================================
// Database connection — plain PostgreSQL via the `postgres` driver,
// wrapped by Drizzle. Replaces the Supabase client for all
// server-side data access.
//
//   import { db } from '@/lib/db'
//   import { sql } from '@/lib/db'   // tagged-template for raw SQL
//
// `db` is the Drizzle query builder (typed against ./schema).
// `sql` is Drizzle's tagged-template helper for raw fragments and
// `db.execute(sql`…`)` calls (e.g. invoking SQL functions).
// ============================================================

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const connectionString = process.env.DATABASE_URL!

// Reuse a single postgres client across hot-reloads in dev so we
// don't exhaust connections (Next.js re-evaluates modules on every
// change). In production this is a plain module-level singleton.
const globalForDb = globalThis as unknown as {
  __wacrmPgClient?: ReturnType<typeof postgres>
}

const client =
  globalForDb.__wacrmPgClient ?? postgres(connectionString, { prepare: false })

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__wacrmPgClient = client
}

export const db = drizzle(client, { schema })

// Re-export the raw postgres client for LISTEN/NOTIFY (the SSE
// realtime endpoint needs a dedicated connection) and any escape
// hatch that needs the driver directly.
export { client as pgClient }

export { sql } from 'drizzle-orm'
export * as schema from './schema'
