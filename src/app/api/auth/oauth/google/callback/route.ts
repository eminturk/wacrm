// ============================================================
// GET /api/auth/oauth/google/callback
//
// Handles the redirect back from Google after the user grants consent.
//
// Flow:
//   1. Validate the `state` cookie to prevent CSRF.
//   2. Exchange the `code` for tokens at Google's token endpoint.
//   3. Fetch the user's profile from Google.
//   4. Upsert the oauth_accounts row and resolve (or create) a local user.
//   5. Create a wacrm session and redirect to /dashboard.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { createHash } from 'crypto'
import { eq, and } from 'drizzle-orm'

import { db } from '@/lib/db'
import { users, oauthAccounts } from '@/lib/db/schema'
import {
  createSession,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  SESSION_MAX_AGE_SECONDS,
} from '@/lib/auth/session'
import { writeAuditLog, getClientIp } from '@/lib/audit'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
const STATE_COOKIE = 'wacrm_oauth_state'

interface GoogleTokenResponse {
  access_token: string
  expires_in: number
  id_token: string
  refresh_token?: string
  token_type: string
}

interface GoogleUserInfo {
  sub: string
  email: string
  email_verified: boolean
  name?: string
  picture?: string
}

function clearStateCookie(response: NextResponse) {
  response.cookies.set(STATE_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
}

export async function GET(request: NextRequest) {
  const ip = getClientIp(request)
  const ua = request.headers.get('user-agent') ?? undefined
  const { searchParams, origin } = new URL(request.url)

  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const errorParam = searchParams.get('error')

  const loginUrl = `${origin}/login`

  if (errorParam) {
    return NextResponse.redirect(`${loginUrl}?error=oauth_denied`)
  }

  // ---- CSRF check ----
  const expectedState = request.cookies.get(STATE_COOKIE)?.value
  if (!state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(`${loginUrl}?error=oauth_state_mismatch`)
  }

  if (!code) {
    return NextResponse.redirect(`${loginUrl}?error=oauth_no_code`)
  }

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(`${loginUrl}?error=oauth_not_configured`)
  }

  const redirectUri = `${origin}/api/auth/oauth/google/callback`

  // ---- Exchange code for tokens ----
  let tokens: GoogleTokenResponse
  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })
    if (!tokenRes.ok) {
      console.error('[oauth/google] token exchange failed', await tokenRes.text())
      return NextResponse.redirect(`${loginUrl}?error=oauth_token_exchange`)
    }
    tokens = (await tokenRes.json()) as GoogleTokenResponse
  } catch (err) {
    console.error('[oauth/google] token exchange error', err)
    return NextResponse.redirect(`${loginUrl}?error=oauth_error`)
  }

  // ---- Fetch user info ----
  let googleUser: GoogleUserInfo
  try {
    const userRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: 'Bearer ' + tokens.access_token },
    })
    if (!userRes.ok) {
      return NextResponse.redirect(`${loginUrl}?error=oauth_userinfo_failed`)
    }
    googleUser = (await userRes.json()) as GoogleUserInfo
  } catch {
    return NextResponse.redirect(`${loginUrl}?error=oauth_error`)
  }

  if (!googleUser.email_verified || !googleUser.email) {
    return NextResponse.redirect(`${loginUrl}?error=oauth_unverified_email`)
  }

  const email = googleUser.email.trim().toLowerCase()
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null

  // ---- Upsert user + oauth_accounts ----
  let userId: string

  try {
    // Does an oauth_accounts row already exist for this provider+sub?
    const existing = await db
      .select({ userId: oauthAccounts.userId })
      .from(oauthAccounts)
      .where(
        and(
          eq(oauthAccounts.provider, 'google'),
          eq(oauthAccounts.providerUserId, googleUser.sub),
        ),
      )
      .limit(1)

    if (existing.length > 0) {
      userId = existing[0].userId
      // Refresh tokens
      await db
        .update(oauthAccounts)
        .set({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? undefined,
          expiresAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(oauthAccounts.provider, 'google'),
            eq(oauthAccounts.providerUserId, googleUser.sub),
          ),
        )
    } else {
      // No oauth_accounts row — find or create the local user.
      const existingUser = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)

      if (existingUser.length > 0) {
        userId = existingUser[0].id
      } else {
        // Brand-new user via OAuth — no password hash.  The sentinel
        // value can never pass bcrypt.compare, so they can't log in
        // with a password until they set one via forgot-password.
        const newUsers = await db
          .insert(users)
          .values({
            email,
            passwordHash: '!oauth-' + createHash('sha256').update(googleUser.sub).digest('hex'),
          })
          .returning({ id: users.id })
        userId = newUsers[0].id
      }

      // Link the OAuth identity
      await db.insert(oauthAccounts).values({
        userId,
        provider: 'google',
        providerUserId: googleUser.sub,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt,
      })
    }
  } catch (err) {
    console.error('[oauth/google] db upsert error', err)
    return NextResponse.redirect(`${loginUrl}?error=oauth_error`)
  }

  // ---- Create session ----
  const token = await createSession(userId)

  void writeAuditLog({
    userId,
    action: 'login.success',
    metadata: { email, provider: 'google' },
    ipAddress: ip,
    userAgent: ua,
  })

  const response = NextResponse.redirect(`${origin}/dashboard`)
  clearStateCookie(response)
  response.cookies.set(
    SESSION_COOKIE_NAME,
    token,
    sessionCookieOptions(SESSION_MAX_AGE_SECONDS),
  )
  return response
}
