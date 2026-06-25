import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { getSession } from '@/lib/auth/session'
import { sessions } from '@/lib/db/schema'

export const runtime = 'nodejs'

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSession()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  await db.delete(sessions).where(and(eq(sessions.id, id), eq(sessions.userId, user.id)))
  return NextResponse.json({ ok: true })
}
