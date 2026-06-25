import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { deals, pipelineStages, pipelines } from '@/lib/db/schema'

export const runtime = 'nodejs'

const dealSelect = {
  id: deals.id,
  user_id: deals.userId,
  account_id: deals.accountId,
  pipeline_id: deals.pipelineId,
  stage_id: deals.stageId,
  contact_id: deals.contactId,
  conversation_id: deals.conversationId,
  assigned_to: deals.assignedTo,
  title: deals.title,
  value: deals.value,
  currency: deals.currency,
  notes: deals.notes,
  expected_close_date: deals.expectedCloseDate,
  status: deals.status,
  created_at: deals.createdAt,
  updated_at: deals.updatedAt,
}

async function ownedDeal(id: string, accountId: string) {
  const [row] = await db
    .select(dealSelect)
    .from(deals)
    .where(and(eq(deals.id, id), eq(deals.accountId, accountId)))
    .limit(1)
  return row
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const ctx = await getCurrentAccount()
    const existing = await ownedDeal(id, ctx.accountId)
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await request.json().catch(() => ({}))
    const update: Partial<typeof deals.$inferInsert> = { updatedAt: new Date() }
    if ('title' in body) update.title = String(body.title ?? '').trim()
    if ('value' in body) update.value = String(Number(body.value ?? 0) || 0)
    if ('currency' in body) update.currency = body.currency
    if ('contact_id' in body) update.contactId = body.contact_id || null
    if ('pipeline_id' in body) update.pipelineId = body.pipeline_id
    if ('stage_id' in body) update.stageId = body.stage_id
    if ('assigned_to' in body) update.assignedTo = body.assigned_to || null
    if ('notes' in body) update.notes = body.notes || null
    if ('expected_close_date' in body) update.expectedCloseDate = body.expected_close_date || null
    if ('status' in body) update.status = body.status

    const pipelineId = update.pipelineId ?? existing.pipeline_id
    const stageId = update.stageId ?? existing.stage_id
    const [pipeline] = await db
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(and(eq(pipelines.id, pipelineId), eq(pipelines.accountId, ctx.accountId)))
      .limit(1)
    const [stage] = await db
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, pipelineId)))
      .limit(1)
    if (!pipeline || !stage) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const [deal] = await db
      .update(deals)
      .set(update)
      .where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)))
      .returning(dealSelect)
    return NextResponse.json({ deal })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const ctx = await getCurrentAccount()
    await db.delete(deals).where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
