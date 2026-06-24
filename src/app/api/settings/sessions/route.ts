import { NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { getSession } from '@/lib/auth/session'
import { sessions } from '@/lib/db/schema'

export const runtime = 'nodejs'

export async function GET() {
  const user = await getSession()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rows = await db
    .select({ id: sessions.id, created_at: sessions.createdAt, expires_at: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.userId, user.id))
    .orderBy(desc(sessions.createdAt))

  return NextResponse.json({
    sessions: rows.map((s) => ({
      id: s.id,
      created_at: s.created_at instanceof Date ? s.created_at.toISOString() : s.created_at,
      expires_at: s.expires_at instanceof Date ? s.expires_at.toISOString() : s.expires_at,
      active: s.expires_at > new Date(),
    })),
  })
}

export async function DELETE() {
  const user = await getSession()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await db.delete(sessions).where(eq(sessions.userId, user.id))
  return NextResponse.json({ ok: true })
}
