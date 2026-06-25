// ============================================================
// POST /api/locale
//
// Sets the wacrm_locale cookie so the user's language preference
// persists across sessions.  Called by the LanguageSwitcher component.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { SUPPORTED_LOCALES, LOCALE_COOKIE, type Locale } from '@/i18n/request'

export async function POST(request: NextRequest) {
  let body: { locale?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const locale = body.locale
  if (!locale || !(SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
    return NextResponse.json(
      { error: `Unsupported locale. Supported: ${SUPPORTED_LOCALES.join(', ')}` },
      { status: 400 },
    )
  }

  const response = NextResponse.json({ ok: true, locale })
  response.cookies.set(LOCALE_COOKIE, locale as Locale, {
    httpOnly: false, // readable by JS so the switcher can show current value
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 365 * 24 * 3600, // 1 year
  })
  return response
}
