// ============================================================
// POST /api/auth/mfa/setup/confirm
//
// Step 2 of MFA setup — verifies the TOTP code from the user's
// authenticator app, activates MFA, and returns recovery codes.
// ============================================================

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { getSession } from '@/lib/auth/session'
import {
  decryptMfaSecret,
  verifyTotp,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '@/lib/auth/mfa'

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { code?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const code = body.code?.trim()
  if (!code || !/^\d{6}$/.test(code)) {
    return NextResponse.json(
      { error: 'A 6-digit TOTP code is required' },
      { status: 400 },
    )
  }

  const rows = await db
    .select({ mfaSecret: users.mfaSecret, mfaEnabled: users.mfaEnabled })
    .from(users)
    .where(eq(users.id, session.id))
    .limit(1)

  const user = rows[0]
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (user.mfaEnabled) {
    return NextResponse.json({ error: 'MFA is already enabled' }, { status: 409 })
  }

  if (!user.mfaSecret) {
    return NextResponse.json(
      { error: 'No pending MFA setup. Call POST /api/auth/mfa/setup first.' },
      { status: 400 },
    )
  }

  let secret: string
  try {
    secret = decryptMfaSecret(user.mfaSecret)
  } catch {
    return NextResponse.json({ error: 'MFA secret is corrupted' }, { status: 500 })
  }

  if (!verifyTotp(code, secret)) {
    return NextResponse.json({ error: 'Invalid TOTP code' }, { status: 400 })
  }

  // Activate MFA and generate recovery codes.
  const recoveryCodes = generateRecoveryCodes(8)
  const hashedCodes = recoveryCodes.map(hashRecoveryCode)

  await db
    .update(users)
    .set({
      mfaEnabled: true,
      mfaRecoveryCodes: hashedCodes,
    })
    .where(eq(users.id, session.id))

  // Return plaintext codes once — the user must save them now.
  return NextResponse.json({ ok: true, recoveryCodes })
}
