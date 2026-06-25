// ============================================================
// Server-side session management — replaces Supabase Auth.
//
// Sessions are opaque random tokens. The plaintext token lives only
// in the `wacrm_session` cookie; the DB stores its SHA-256 hash. A
// stolen DB therefore can't be used to mint cookies.
//
//   getSession()      — read + validate the current request's cookie
//   createSession()   — mint a token for a user (returns plaintext)
//   destroySession()  — delete a session by its plaintext token
//   sessionCookieOptions / SESSION_COOKIE_NAME — for route handlers
//
// This module is server-only (imports next/headers). Do NOT import
// it from a client component.
// ============================================================

import { cookies } from 'next/headers'
import { createHash, randomBytes } from 'crypto'
import { eq, gt, and, lt } from 'drizzle-orm'

import { db } from '@/lib/db'
import { sessions, users } from '@/lib/db/schema'

export const SESSION_COOKIE_NAME = 'wacrm_session'
const SESSION_DURATION_DAYS = 30
const SESSION_DURATION_MS = SESSION_DURATION_DAYS * 86_400_000

export interface SessionUser {
  id: string
  email: string
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Cookie attributes shared by login (set) and logout (clear). Secure
 * in production; lax same-site so top-level navigations carry it.
 */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  }
}

export const SESSION_MAX_AGE_SECONDS = SESSION_DURATION_MS / 1000

/**
 * Resolve the current request's session into a user, or null when
 * there's no cookie, the token is unknown, or it has expired.
 */
export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value
  if (!token) return null
  return getSessionByToken(token)
}

/**
 * Validate a plaintext token directly (used by middleware, which
 * reads the cookie off the request rather than via next/headers).
 */
export async function getSessionByToken(token: string): Promise<SessionUser | null> {
  const tokenHash = hashToken(token)
  const result = await db
    .select({ userId: sessions.userId, userEmail: users.email })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1)

  if (!result.length) return null
  return { id: result[0].userId, email: result[0].userEmail }
}

/**
 * Mint a new session for a user. Returns the plaintext token to set
 * in the cookie. The DB only ever sees the hash.
 */
export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex')
  const tokenHash = hashToken(token)
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS)

  await db.insert(sessions).values({ userId, tokenHash, expiresAt })

  return token
}

/** Delete a session by its plaintext token (idempotent). */
export async function destroySession(token: string): Promise<void> {
  const tokenHash = hashToken(token)
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash))
}

/** Best-effort sweep of expired rows. Safe to call opportunistically. */
export async function purgeExpiredSessions(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()))
}
