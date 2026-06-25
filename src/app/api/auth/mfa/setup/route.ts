// ============================================================
// POST /api/auth/mfa/setup
//
// Step 1 — generate a TOTP secret and return the QR code URI.
//           Does NOT enable MFA yet; the client must complete
//           /api/auth/mfa/setup/confirm to activate.
//
// GET  /api/auth/mfa/setup
//           Returns the pending secret URI (to re-render the QR).
// ============================================================

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import QRCode from 'qrcode'

import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { getSession } from '@/lib/auth/session'
import {
  generateTotpSecret,
  buildTotpUri,
  encryptMfaSecret,
  decryptMfaSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyTotp,
} from '@/lib/auth/mfa'

async function resolveUser() {
  const session = await getSession()
  if (!session) return null
  const rows = await db
    .select({ id: users.id, email: users.email, mfaEnabled: users.mfaEnabled, mfaSecret: users.mfaSecret })
    .from(users)
    .where(eq(users.id, session.id))
    .limit(1)
  return rows[0] ?? null
}

/** GET — return setup status. */
export async function GET() {
  const user = await resolveUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  return NextResponse.json({
    mfaEnabled: user.mfaEnabled,
    hasPendingSecret: Boolean(user.mfaSecret && !user.mfaEnabled),
  })
}

/**
 * POST — generate (or regenerate) the TOTP secret and return the QR
 * code.  MFA is NOT yet active until the user confirms with a valid code.
 */
export async function POST() {
  const user = await resolveUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (user.mfaEnabled) {
    return NextResponse.json(
      { error: 'MFA is already enabled. Disable it first.' },
      { status: 409 },
    )
  }

  const secret = generateTotpSecret()
  const uri = buildTotpUri(secret, user.email)
  const encryptedSecret = encryptMfaSecret(secret)

  // Store the pending secret (not enabled yet).
  await db
    .update(users)
    .set({ mfaSecret: encryptedSecret })
    .where(eq(users.id, user.id))

  const qrDataUrl = await QRCode.toDataURL(uri)

  return NextResponse.json({ qrDataUrl, uri })
}
