// ============================================================
// Client-safe auth helpers.
//
// Replaces the Supabase browser client. The browser can no longer
// talk to Postgres directly (no PostgREST + RLS), so authentication
// goes through our own `/api/auth/*` route handlers which set/clear
// the `wacrm_session` cookie.
//
// These helpers are intentionally tiny — components fetch their data
// from purpose-built API routes, not a generic query client.
// ============================================================

'use client'

export interface AuthUser {
  id: string
  email: string
}

export interface AuthResult {
  ok: boolean
  mfaRequired?: boolean
  error?: string
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    return body.error ?? `Request failed (${res.status})`
  } catch {
    return `Request failed (${res.status})`
  }
}

/** GET the current signed-in user, or null if not authenticated. */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const res = await fetch('/api/auth/me', { cache: 'no-store' })
  if (!res.ok) return null
  const body = (await res.json()) as { user?: AuthUser | null }
  return body.user ?? null
}

/**
 * Email + password sign-in.
 * - On success the session cookie is set and `ok: true` is returned.
 * - When the account has MFA enabled `mfaRequired: true` is returned
 *   instead; the caller should redirect to /mfa-verify.
 */
export async function signIn(
  email: string,
  password: string,
): Promise<AuthResult> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) return { ok: false, error: await readError(res) }
  const body = (await res.json()) as { ok?: boolean; mfaRequired?: boolean }
  if (body.mfaRequired) return { ok: false, mfaRequired: true }
  return { ok: true }
}

/** Create a new user (+ profile + account) and sign them in. */
export async function signUp(
  email: string,
  password: string,
  fullName: string,
): Promise<AuthResult> {
  const res = await fetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, fullName }),
  })
  if (!res.ok) return { ok: false, error: await readError(res) }
  return { ok: true }
}

/** Destroy the current session. */
export async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' })
}

/** Request a password-reset email. Always resolves ok (no enumeration). */
export async function requestPasswordReset(email: string): Promise<AuthResult> {
  const res = await fetch('/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!res.ok) return { ok: false, error: await readError(res) }
  return { ok: true }
}

/** Update the signed-in user's password. */
export async function updatePassword(password: string): Promise<AuthResult> {
  const res = await fetch('/api/auth/update-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (!res.ok) return { ok: false, error: await readError(res) }
  return { ok: true }
}

/** Initiate Google OAuth login — navigates the browser to Google's consent screen. */
export function signInWithGoogle(): void {
  window.location.href = '/api/auth/oauth/google'
}
