// ============================================================
// GET /api/auth/oauth/google
//
// Redirects the browser to Google's OAuth 2.0 consent screen.
// Generates a random `state` token (stored in a short-lived cookie)
// to prevent CSRF on the callback.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { randomBytes } from 'crypto'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const SCOPES = ['openid', 'email', 'profile'].join(' ')
const STATE_COOKIE = 'wacrm_oauth_state'

export async function GET(request: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId) {
    return NextResponse.json(
      { error: 'Google OAuth is not configured' },
      { status: 503 },
    )
  }

  const origin = new URL(request.url).origin
  const redirectUri = `${origin}/api/auth/oauth/google/callback`

  const state = randomBytes(16).toString('hex')

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    state,
    access_type: 'offline',
    prompt: 'select_account',
  })

  const response = NextResponse.redirect(`${GOOGLE_AUTH_URL}?${params}`)

  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600, // 10 minutes — enough to complete the OAuth flow
  })

  return response
}
