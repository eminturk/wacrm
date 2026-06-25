// ============================================================
// MFA helpers
//
// TOTP-based multi-factor authentication using RFC 6238.
//
// Flow when a user has MFA enabled:
//   1. /api/auth/login validates the password.
//   2. Instead of creating a full session it creates a *pending* MFA
//      session (a short-lived token stored hashed in the DB) and
//      returns { mfaRequired: true }.
//   3. The client shows the TOTP code form and POSTs to
//      /api/auth/mfa/verify with the pending token + the 6-digit code.
//   4. On success a real wacrm_session is issued.
//
// Server-only — imports next/headers indirectly via session.ts.
// ============================================================

import { createHash, randomBytes } from 'crypto'
import { eq, gt, and, lt } from 'drizzle-orm'
import { generateSecret, generateURI, verifySync } from 'otplib'

import { db } from '@/lib/db'
import { pendingMfaSessions, users } from '@/lib/db/schema'

export const PENDING_MFA_COOKIE = 'wacrm_mfa_pending'
const PENDING_MFA_DURATION_MS = 10 * 60 * 1000 // 10 minutes

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// ---- Pending MFA session ----

/** Create a short-lived pending-MFA token for `userId`. */
export async function createPendingMfaSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex')
  const tokenHash = hashToken(token)
  const expiresAt = new Date(Date.now() + PENDING_MFA_DURATION_MS)
  await db.insert(pendingMfaSessions).values({ userId, tokenHash, expiresAt })
  return token
}

/** Resolve and consume a pending MFA token. Returns userId or null. */
export async function consumePendingMfaSession(
  token: string,
): Promise<string | null> {
  const tokenHash = hashToken(token)
  const rows = await db
    .select({ id: pendingMfaSessions.id, userId: pendingMfaSessions.userId })
    .from(pendingMfaSessions)
    .where(
      and(
        eq(pendingMfaSessions.tokenHash, tokenHash),
        gt(pendingMfaSessions.expiresAt, new Date()),
      ),
    )
    .limit(1)

  if (!rows.length) return null

  // Delete immediately — single-use.
  await db
    .delete(pendingMfaSessions)
    .where(eq(pendingMfaSessions.id, rows[0].id))

  return rows[0].userId
}

/** Sweep expired pending rows (call opportunistically). */
export async function purgeExpiredPendingMfa(): Promise<void> {
  await db
    .delete(pendingMfaSessions)
    .where(lt(pendingMfaSessions.expiresAt, new Date()))
}

// ---- TOTP helpers ----

/** Generate a new random TOTP secret (base32). */
export function generateTotpSecret(): string {
  return generateSecret({ length: 20 })
}

/** Build the otpauth:// URI that authenticator apps scan. */
export function buildTotpUri(secret: string, email: string): string {
  return generateURI({
    issuer: 'wacrm',
    label: email,
    secret,
    strategy: 'totp',
  })
}

/**
 * Verify a 6-digit TOTP code against the secret.
 * Uses ±1 window (±30 s) for clock skew tolerance.
 */
export function verifyTotp(token: string, secret: string): boolean {
  const result = verifySync({ token, secret, epochTolerance: 30 })
  return result.valid
}

// ---- Recovery codes ----

/** Generate N single-use recovery codes. */
export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () =>
    randomBytes(5).toString('hex').toUpperCase(),
  )
}

/**
 * Hash a recovery code for storage.  SHA-256 is fine here because
 * recovery codes are long-random, not user-chosen passwords.
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex')
}

/**
 * Check whether a supplied recovery code matches any stored hash.
 * Returns the matching hash (to remove it) or null.
 */
export function matchRecoveryCode(
  supplied: string,
  hashes: string[],
): string | null {
  const h = hashRecoveryCode(supplied)
  return hashes.find((stored) => stored === h) ?? null
}

// ---- MFA secret encryption ----
//
// We store the TOTP secret encrypted in the database using AES-256-GCM
// so a DB dump doesn't immediately yield working TOTP secrets.
// The encryption key is the first 32 bytes of ENCRYPTION_KEY (same
// key used for WhatsApp token encryption elsewhere in the app).

import { createCipheriv, createDecipheriv } from 'crypto'

function getEncKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY
  if (!hex || hex.length < 64) {
    throw new Error('ENCRYPTION_KEY must be at least 64 hex chars')
  }
  return Buffer.from(hex.slice(0, 64), 'hex')
}

/** Encrypt a TOTP secret for storage. Returns "iv:tag:ciphertext" (hex). */
export function encryptMfaSecret(secret: string): string {
  const key = getEncKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // iv:tag:ciphertext — all hex
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

/** Decrypt a stored TOTP secret. Throws on tamper/wrong key. */
export function decryptMfaSecret(stored: string): string {
  const [ivHex, tagHex, ciphertextHex] = stored.split(':')
  if (!ivHex || !tagHex || !ciphertextHex) {
    throw new Error('Invalid MFA secret format')
  }
  const key = getEncKey()
  const iv = Buffer.from(ivHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  const ciphertext = Buffer.from(ciphertextHex, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext) + decipher.final('utf8')
}

/** Load + decrypt the stored MFA secret for `userId`. */
export async function getUserMfaSecret(userId: string): Promise<string | null> {
  const rows = await db
    .select({ mfaSecret: users.mfaSecret, mfaEnabled: users.mfaEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  const row = rows[0]
  if (!row || !row.mfaSecret) return null
  return decryptMfaSecret(row.mfaSecret)
}

