// ============================================================
// i18n configuration for next-intl.
//
// Supported locales: English (en), Turkish (tr), German (de).
// The default locale is English.
//
// Locale detection order:
//   1. `NEXT_LOCALE` cookie (set by the language switcher)
//   2. Accept-Language header
//   3. Default: 'en'
//
// next-intl docs: https://next-intl.dev/docs/getting-started/app-router
// ============================================================

import { getRequestConfig } from 'next-intl/server'
import { cookies, headers } from 'next/headers'

export const SUPPORTED_LOCALES = ['en', 'tr', 'de'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'
export const LOCALE_COOKIE = 'wacrm_locale'

/**
 * Detect the best matching locale from the request.
 * Priority: cookie → Accept-Language header → default.
 */
async function detectLocale(): Promise<Locale> {
  const cookieStore = await cookies()
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value
  if (fromCookie && isSupportedLocale(fromCookie)) return fromCookie

  const headerStore = await headers()
  const acceptLanguage = headerStore.get('accept-language')
  if (acceptLanguage) {
    const preferred = parseAcceptLanguage(acceptLanguage)
    const match = preferred.find(isSupportedLocale)
    if (match) return match
  }

  return DEFAULT_LOCALE
}

function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/** Parse Accept-Language header into a list of locale tags (stripped of quality). */
function parseAcceptLanguage(header: string): string[] {
  return header
    .split(',')
    .map((part) => {
      const [tag] = part.split(';')
      return tag.trim().toLowerCase().split('-')[0] // e.g. 'en-US' → 'en'
    })
    .filter(Boolean)
}

export default getRequestConfig(async () => {
  const locale = await detectLocale()
  const messages = (await import(`../../messages/${locale}.json`)) as { default: Record<string, unknown> }

  return {
    locale,
    messages: messages.default,
  }
})
