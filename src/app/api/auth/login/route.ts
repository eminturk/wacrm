import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'

import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import {
  createSession,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  SESSION_MAX_AGE_SECONDS,
} from '@/lib/auth/session'

export async function POST(request: Request) {
  let body: { email?: string; password?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const email = body.email?.trim().toLowerCase()
  const password = body.password

  if (!email || !password) {
    return NextResponse.json(
      { error: 'Email and password are required' },
      { status: 400 },
    )
  }

  const rows = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)

  const user = rows[0]
  // Always run a compare to keep timing roughly constant whether or not
  // the email exists.
  const hash = user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva'
  const valid = await bcrypt.compare(password, hash)

  if (!user || !valid) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
  }

  const token = await createSession(user.id)

  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(SESSION_MAX_AGE_SECONDS))
  return res
}
