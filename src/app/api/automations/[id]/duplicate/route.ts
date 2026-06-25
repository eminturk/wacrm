import { NextResponse } from 'next/server'
import { and, asc, eq } from 'drizzle-orm'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { automations, automationSteps } from '@/lib/db/schema'

const automationSelect = {
  id: automations.id,
  user_id: automations.userId,
  account_id: automations.accountId,
  name: automations.name,
  description: automations.description,
  trigger_type: automations.triggerType,
  trigger_config: automations.triggerConfig,
  is_active: automations.isActive,
  execution_count: automations.executionCount,
  last_executed_at: automations.lastExecutedAt,
  created_at: automations.createdAt,
  updated_at: automations.updatedAt,
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await getCurrentAccount()

    const [original] = await ctx.db
      .select(automationSelect)
      .from(automations)
      .where(and(eq(automations.id, id), eq(automations.accountId, ctx.accountId)))
      .limit(1)
    if (!original) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const [copy] = await ctx.db
      .insert(automations)
      .values({
        accountId: ctx.accountId,
        userId: ctx.userId,
        name: `${original.name} (Copy)`,
        description: original.description,
        triggerType: original.trigger_type,
        triggerConfig: original.trigger_config,
        isActive: false,
      })
      .returning(automationSelect)
    if (!copy) {
      return NextResponse.json({ error: 'copy failed' }, { status: 500 })
    }

    const steps = await ctx.db
      .select({
        id: automationSteps.id,
        parent_step_id: automationSteps.parentStepId,
        branch: automationSteps.branch,
        step_type: automationSteps.stepType,
        step_config: automationSteps.stepConfig,
        position: automationSteps.position,
      })
      .from(automationSteps)
      .where(eq(automationSteps.automationId, id))
      .orderBy(asc(automationSteps.position))

    if (steps.length > 0) {
      const idMap = new Map<string, string>()
      const uid = () =>
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2) + Date.now().toString(36)
      for (const row of steps) idMap.set(row.id as string, uid())

      const rows = steps.map((row) => ({
        id: idMap.get(row.id as string)!,
        automationId: copy.id,
        parentStepId: row.parent_step_id ? idMap.get(row.parent_step_id as string) : null,
        branch: row.branch,
        stepType: row.step_type,
        stepConfig: row.step_config,
        position: row.position,
      }))
      await ctx.db.insert(automationSteps).values(rows)
    }

    return NextResponse.json({ automation: copy }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
