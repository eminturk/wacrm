// ============================================================
// POST /api/auth/mfa/disable
//
// Disables MFA for the current user.  Requires a valid TOTP code
// or recovery code as confirmation before deactivating.
// ============================================================

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { getSession } from '@/lib/auth/session'
import {
  verifyTotp,
  decryptMfaSecret,
  matchRecoveryCode,
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
  if (!code) {
    return NextResponse.json(
      { error: 'A TOTP or recovery code is required to disable MFA' },
      { status: 400 },
    )
  }

  const rows = await db
    .select({
      mfaSecret: users.mfaSecret,
      mfaEnabled: users.mfaEnabled,
      mfaRecoveryCodes: users.mfaRecoveryCodes,
    })
    .from(users)
    .where(eq(users.id, session.id))
    .limit(1)

  const user = rows[0]
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!user.mfaEnabled || !user.mfaSecret) {
    return NextResponse.json({ error: 'MFA is not enabled' }, { status: 409 })
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
    if (!verifyTotp(code, secret)) {
      return NextResponse.json({ error: 'Invalid TOTP code' }, { status: 401 })
    }
  } else {
    const match = matchRecoveryCode(code, storedHashes)
    if (!match) {
      return NextResponse.json({ error: 'Invalid recovery code' }, { status: 401 })
    }
  }

  await db
    .update(users)
    .set({
      mfaEnabled: false,
      mfaSecret: null,
      mfaRecoveryCodes: [],
    })
    .where(eq(users.id, session.id))

  return NextResponse.json({ ok: true })
}
