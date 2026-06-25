// ============================================================
// POST /api/auth/mfa/verify
//
// Called after a successful password login when mfaRequired === true.
// The client supplies the pending token (from the wacrm_mfa_pending
// cookie) and the 6-digit TOTP code (or a recovery code).
//
// On success:  clears the pending cookie, issues a full wacrm_session.
// On failure:  returns 401 (wrong code) or 400 (bad token/expired).
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { profiles, users } from '@/lib/db/schema'
import {
  createSession,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  SESSION_MAX_AGE_SECONDS,
} from '@/lib/auth/session'
import {
  consumePendingMfaSession,
  PENDING_MFA_COOKIE,
  verifyTotp,
  decryptMfaSecret,
  matchRecoveryCode,
} from '@/lib/auth/mfa'
import { writeAuditLog, getClientIp } from '@/lib/audit'

export async function POST(request: NextRequest) {
  const ip = getClientIp(request)
  const ua = request.headers.get('user-agent') ?? undefined

  let body: { code?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const code = body.code?.trim()
  if (!code) {
    return NextResponse.json({ error: 'code is required' }, { status: 400 })
  }

  // Retrieve the pending MFA token from the cookie.
  const pendingToken = request.cookies.get(PENDING_MFA_COOKIE)?.value
  if (!pendingToken) {
    return NextResponse.json(
      { error: 'No pending MFA session. Please sign in again.' },
      { status: 400 },
    )
  }

  // Consume (validate + delete) the pending token.
  const userId = await consumePendingMfaSession(pendingToken)
  if (!userId) {
    return NextResponse.json(
      { error: 'MFA session expired or invalid. Please sign in again.' },
      { status: 401 },
    )
  }

  // Load the user's MFA state.
  const rows = await db
    .select({
      mfaSecret: users.mfaSecret,
      mfaEnabled: users.mfaEnabled,
      mfaRecoveryCodes: users.mfaRecoveryCodes,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const user = rows[0]
  if (!user || !user.mfaEnabled || !user.mfaSecret) {
    return NextResponse.json({ error: 'MFA not configured' }, { status: 400 })
  }

  let secret: string
  try {
    secret = decryptMfaSecret(user.mfaSecret)
  } catch {
    return NextResponse.json({ error: 'MFA secret is corrupted' }, { status: 500 })
  }

  const storedHashes = (user.mfaRecoveryCodes as string[]) ?? []
  const isTotp = /^\d{6}$/.test(code)

  if (isTotp) {
    // TOTP verification
    if (!verifyTotp(code, secret)) {
      void writeAuditLog({
        userId,
        action: 'mfa.failure',
        metadata: { email: user.email, reason: 'invalid_totp' },
        ipAddress: ip,
        userAgent: ua,
      })
      return NextResponse.json({ error: 'Invalid TOTP code' }, { status: 401 })
    }
  } else {
    // Recovery code verification
    const matchedHash = matchRecoveryCode(code, storedHashes)
    if (!matchedHash) {
      void writeAuditLog({
        userId,
        action: 'mfa.failure',
        metadata: { email: user.email, reason: 'invalid_recovery_code' },
        ipAddress: ip,
        userAgent: ua,
      })
      return NextResponse.json({ error: 'Invalid recovery code' }, { status: 401 })
    }
    // Consume the recovery code — remove the matched hash.
    const remaining = storedHashes.filter((h) => h !== matchedHash)
    await db
      .update(users)
      .set({ mfaRecoveryCodes: remaining })
      .where(eq(users.id, userId))
  }

  // Resolve account_id for the audit log
  const profileRows = await db
    .select({ accountId: profiles.accountId })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1)
  const accountId = profileRows[0]?.accountId ?? null

  const token = await createSession(userId)

  void writeAuditLog({
    accountId,
    userId,
    action: 'login.success',
    metadata: { email: user.email, mfa: true },
    ipAddress: ip,
    userAgent: ua,
  })

  const res = NextResponse.json({ ok: true })
  // Clear the pending cookie
  res.cookies.set(PENDING_MFA_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
  res.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(SESSION_MAX_AGE_SECONDS))
  return res
}
