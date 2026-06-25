import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'

import { db } from '@/lib/db'
import { profiles, users } from '@/lib/db/schema'
import {
  createSession,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  SESSION_MAX_AGE_SECONDS,
} from '@/lib/auth/session'
import { writeAuditLog, getClientIp } from '@/lib/audit'

export async function POST(request: Request) {
  const ip = getClientIp(request)
  const ua = request.headers.get('user-agent') ?? undefined

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
    // Fire-and-forget: audit login failure (no account_id yet)
    void writeAuditLog({
      userId: user?.id ?? null,
      action: 'login.failure',
      metadata: { email },
      ipAddress: ip,
      userAgent: ua,
    })
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
  }

  // Resolve account_id for the audit log
  const profileRows = await db
    .select({ accountId: profiles.accountId })
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1)
  const accountId = profileRows[0]?.accountId ?? null

  const token = await createSession(user.id)

  void writeAuditLog({
    accountId,
    userId: user.id,
    action: 'login.success',
    metadata: { email },
    ipAddress: ip,
    userAgent: ua,
  })

  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(SESSION_MAX_AGE_SECONDS))
  return res
}
