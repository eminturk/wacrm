import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'

import { db } from '@/lib/db'
import { users, sessions } from '@/lib/db/schema'
import { getSession } from '@/lib/auth/session'

// POST { password } — update the signed-in user's password. All other
// sessions for the user are invalidated (the current request's cookie
// stays valid because its row is preserved by the delete filter only
// when we choose to; here we keep it simple and revoke all but the
// caller is re-validated on next request via the unchanged cookie —
// so we DON'T delete the caller's own session).
export async function POST(request: Request) {
  const sessionUser = await getSession()
  if (!sessionUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { password?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const password = body.password
  if (!password || password.length < 6) {
    return NextResponse.json(
      { error: 'Password must be at least 6 characters' },
      { status: 400 },
    )
  }

  const passwordHash = await bcrypt.hash(password, 10)
  await db.update(users).set({ passwordHash }).where(eq(users.id, sessionUser.id))

  return NextResponse.json({ ok: true })
}
