import { NextResponse } from 'next/server'

import { getSession } from '@/lib/auth/session'

// GET the current signed-in user. Returns { user: null } (200) when
// there's no valid session — middleware and the client auth helpers
// rely on this rather than a 401 so they can branch cleanly.
export async function GET() {
  const user = await getSession()
  return NextResponse.json({ user: user ?? null })
}
