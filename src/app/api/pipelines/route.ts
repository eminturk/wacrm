import { NextResponse } from 'next/server'
import { asc, eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { pipelineStages, pipelines } from '@/lib/db/schema'

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

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const rows = await db
      .select(pipelineSelect)
      .from(pipelines)
      .where(eq(pipelines.accountId, ctx.accountId))
      .orderBy(asc(pipelines.createdAt))
    return NextResponse.json({ pipelines: rows })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = await request.json().catch(() => ({}))
    const name = String(body.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'Pipeline name is required' }, { status: 400 })

    const [pipeline] = await db
      .insert(pipelines)
      .values({ userId: ctx.userId, accountId: ctx.accountId, name })
      .returning(pipelineSelect)

    const stages = Array.isArray(body.stages) ? body.stages : []
    if (pipeline && stages.length > 0) {
      await db.insert(pipelineStages).values(
        stages.map((s: { name?: string; color?: string; position?: number }, index: number) => ({
          pipelineId: pipeline.id,
          name: String(s.name ?? '').trim() || `Stage ${index + 1}`,
          color: String(s.color ?? '#3b82f6'),
          position: Number.isFinite(s.position) ? Number(s.position) : index,
        })),
      )
    }

    const createdStages = pipeline
      ? await db
          .select(stageSelect)
          .from(pipelineStages)
          .where(eq(pipelineStages.pipelineId, pipeline.id))
          .orderBy(asc(pipelineStages.position))
      : []

    return NextResponse.json({ pipeline, stages: createdStages }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
