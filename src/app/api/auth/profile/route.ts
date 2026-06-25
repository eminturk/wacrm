import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { profiles, accounts } from '@/lib/db/schema'
import { getSession } from '@/lib/auth/session'

export const runtime = 'nodejs'

// GET — the signed-in user's enriched profile + account summary.
// Consumed by the client AuthProvider (src/hooks/use-auth.tsx) to
// populate role gates and the default-currency picker. Returns
// { profile: null } (200) when there's no session.
export async function GET() {
  const sessionUser = await getSession()
  if (!sessionUser) {
    return NextResponse.json({ profile: null })
  }

  const rows = await db
    .select({
      id: profiles.id,
      fullName: profiles.fullName,
      email: profiles.email,
      avatarUrl: profiles.avatarUrl,
      role: profiles.role,
      betaFeatures: profiles.betaFeatures,
      accountId: profiles.accountId,
      accountRole: profiles.accountRole,
      accountName: accounts.name,
      accountDefaultCurrency: accounts.defaultCurrency,
    })
    .from(profiles)
    .leftJoin(accounts, eq(profiles.accountId, accounts.id))
    .where(eq(profiles.userId, sessionUser.id))
    .limit(1)

  const p = rows[0]
  if (!p) {
    return NextResponse.json({ profile: null })
  }

  return NextResponse.json({
    user: { id: sessionUser.id, email: sessionUser.email },
    profile: {
      id: p.id,
      full_name: p.fullName,
      email: p.email,
      avatar_url: p.avatarUrl,
      role: p.role,
      beta_features: p.betaFeatures ?? [],
      account_id: p.accountId,
      account_role: p.accountRole,
    },
    account: p.accountId
      ? {
          id: p.accountId,
          name: p.accountName,
          default_currency: p.accountDefaultCurrency,
        }
      : null,
  })
}
