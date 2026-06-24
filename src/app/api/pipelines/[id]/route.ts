import { NextResponse } from 'next/server'
import { and, asc, count, eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { deals, pipelineStages, pipelines } from '@/lib/db/schema'

export const runtime = 'nodejs'

const pipelineSelect = {
  id: pipelines.id,
  user_id: pipelines.userId,
  account_id: pipelines.accountId,
  name: pipelines.name,
  created_at: pipelines.createdAt,
}

const stageSelect = {
  id: pipelineStages.id,
  pipeline_id: pipelineStages.pipelineId,
  name: pipelineStages.name,
  position: pipelineStages.position,
  color: pipelineStages.color,
  created_at: pipelineStages.createdAt,
}

async function ownedPipeline(id: string, accountId: string) {
  const [row] = await db
    .select(pipelineSelect)
    .from(pipelines)
    .where(and(eq(pipelines.id, id), eq(pipelines.accountId, accountId)))
    .limit(1)
  return row
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const ctx = await getCurrentAccount()
    const pipeline = await ownedPipeline(id, ctx.accountId)
    if (!pipeline) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const stages = await db
      .select(stageSelect)
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, id))
      .orderBy(asc(pipelineStages.position))
    return NextResponse.json({ pipeline, stages })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const ctx = await requireRole('admin')
    const pipeline = await ownedPipeline(id, ctx.accountId)
    if (!pipeline) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await request.json().catch(() => ({}))
    if (body.action !== 'create_stage') {
      return NextResponse.json({ error: 'Unsupported action' }, { status: 400 })
    }
    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'Stage name is required' }, { status: 400 })

    const [stage] = await db
      .insert(pipelineStages)
      .values({
        pipelineId: id,
        name,
        color: String(body.color ?? '#3b82f6'),
        position: Number.isFinite(body.position) ? Number(body.position) : 0,
      })
      .returning(stageSelect)
    return NextResponse.json({ stage }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const ctx = await requireRole('admin')
    const pipeline = await ownedPipeline(id, ctx.accountId)
    if (!pipeline) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await request.json().catch(() => ({}))
    let updatedPipeline = pipeline
    if (typeof body.name === 'string' && body.name.trim()) {
      const [row] = await db
        .update(pipelines)
        .set({ name: body.name.trim() })
        .where(and(eq(pipelines.id, id), eq(pipelines.accountId, ctx.accountId)))
        .returning(pipelineSelect)
      if (row) updatedPipeline = row
    }

    if (Array.isArray(body.stages)) {
      for (const stage of body.stages as Array<{ id?: string; name?: string; color?: string; position?: number }>) {
        if (!stage.id) continue
        await db
          .update(pipelineStages)
          .set({
            name: String(stage.name ?? '').trim() || 'Untitled stage',
            color: String(stage.color ?? '#3b82f6'),
            position: Number(stage.position ?? 0),
          })
          .where(and(eq(pipelineStages.id, stage.id), eq(pipelineStages.pipelineId, id)))
      }
    }

    const stages = await db
      .select(stageSelect)
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, id))
      .orderBy(asc(pipelineStages.position))
    return NextResponse.json({ pipeline: updatedPipeline, stages })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const ctx = await requireRole('admin')
    const pipeline = await ownedPipeline(id, ctx.accountId)
    if (!pipeline) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const url = new URL(request.url)
    const stageId = url.searchParams.get('stageId')
    if (stageId) {
      const [{ c }] = await db
        .select({ c: count() })
        .from(deals)
        .where(and(eq(deals.accountId, ctx.accountId), eq(deals.stageId, stageId)))
      if (c > 0) {
        return NextResponse.json({ error: 'Move or delete deals in this stage first' }, { status: 409 })
      }
      await db
        .delete(pipelineStages)
        .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, id)))
      return NextResponse.json({ ok: true })
    }

    await db.delete(pipelines).where(and(eq(pipelines.id, id), eq(pipelines.accountId, ctx.accountId)))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
