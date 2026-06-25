import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

import {
  destroySession,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from '@/lib/auth/session'

export async function POST() {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value
  if (token) {
    await destroySession(token)
  }

  const res = NextResponse.json({ ok: true })
  // Clear the cookie by setting maxAge 0.
  res.cookies.set(SESSION_COOKIE_NAME, '', sessionCookieOptions(0))
  return res
}
