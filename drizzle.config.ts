import type { Config } from 'drizzle-kit'

// Drizzle Kit config — generate + push migrations from the Drizzle
// schema. The hand-written SQL under supabase/migrations remains the
// source of truth for the historical schema + functions/triggers; use
// `drizzle-kit` for new schema changes going forward.
export default {
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config
