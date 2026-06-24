import { NextResponse } from 'next/server'
import { and, asc, eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { tags } from '@/lib/db/schema'

export const runtime = 'nodejs'

const tagSelect = {
  id: tags.id,
  user_id: tags.userId,
  account_id: tags.accountId,
  name: tags.name,
  color: tags.color,
  created_at: tags.createdAt,
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const rows = await db
      .select(tagSelect)
      .from(tags)
      .where(eq(tags.accountId, ctx.accountId))
      .orderBy(asc(tags.createdAt))
    return NextResponse.json({ tags: rows })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = await request.json().catch(() => ({}))
    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'Tag name is required' }, { status: 400 })
    const [tag] = await db
      .insert(tags)
      .values({ userId: ctx.userId, accountId: ctx.accountId, name, color: String(body.color ?? '#10b981') })
      .returning(tagSelect)
    return NextResponse.json({ tag }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const id = new URL(request.url).searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
    await db.delete(tags).where(and(eq(tags.id, id), eq(tags.accountId, ctx.accountId)))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
