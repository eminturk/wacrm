import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'

import { db } from '@/lib/db'
import { users, profiles, accounts } from '@/lib/db/schema'
import {
  createSession,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  SESSION_MAX_AGE_SECONDS,
} from '@/lib/auth/session'

export async function POST(request: Request) {
  let body: { email?: string; password?: string; fullName?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const email = body.email?.trim().toLowerCase()
  const password = body.password
  const fullName = body.fullName?.trim() ?? ''

  if (!email || !password) {
    return NextResponse.json(
      { error: 'Email and password are required' },
      { status: 400 },
    )
  }
  if (password.length < 6) {
    return NextResponse.json(
      { error: 'Password must be at least 6 characters' },
      { status: 400 },
    )
  }

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
  if (existing.length) {
    return NextResponse.json(
      { error: 'An account with this email already exists' },
      { status: 409 },
    )
  }

  const passwordHash = await bcrypt.hash(password, 10)

  let userId: string
  try {
    // Insert the user. The on_user_created trigger bootstraps the
    // account + owner profile (named after the email). We then patch
    // the full name + account name to what the user provided.
    const inserted = await db
      .insert(users)
      .values({ email, passwordHash })
      .returning({ id: users.id })
    userId = inserted[0].id

    if (fullName) {
      await db.update(profiles).set({ fullName }).where(eq(profiles.userId, userId))

      const prof = await db
        .select({ accountId: profiles.accountId })
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1)
      const accountId = prof[0]?.accountId
      if (accountId) {
        await db.update(accounts).set({ name: fullName }).where(eq(accounts.id, accountId))
      }
    }
  } catch (err) {
    console.error('[auth/signup] error:', err)
    return NextResponse.json({ error: 'Could not create account' }, { status: 500 })
  }

  const token = await createSession(userId)

  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(SESSION_MAX_AGE_SECONDS))
  return res
}
