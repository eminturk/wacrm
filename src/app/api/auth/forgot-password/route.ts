import { NextResponse } from 'next/server'

// POST { email } — request a password reset.
//
// This self-hosted template ships without a transactional email
// provider wired up, so we don't reveal whether the address exists
// (no user enumeration) and always return 200. Operators can plug an
// email sender + a signed reset token here. The previous Supabase
// implementation delegated this to Supabase Auth's built-in mailer.
export async function POST(request: Request) {
  let body: { email?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const email = body.email?.trim().toLowerCase()
  if (!email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 })
  }

  // Intentionally a no-op beyond input validation. Wire up an email
  // provider + signed reset token to deliver an actual reset link.
  console.info('[auth/forgot-password] reset requested for:', email)

  return NextResponse.json({ ok: true })
}
