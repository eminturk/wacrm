import { NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { automations } from '@/lib/db/schema'
import { getTemplate } from '@/lib/automations/templates'
import { insertSteps, type BuilderStepInput } from '@/lib/automations/steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'

export const runtime = 'nodejs'

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

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const data = await ctx.db
      .select(automationSelect)
      .from(automations)
      .where(eq(automations.accountId, ctx.accountId))
      .orderBy(desc(automations.createdAt))
    return NextResponse.json({ automations: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = await request.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

    const { name, description, trigger_type, trigger_config, is_active, steps, template } = body

    let effectiveSteps: BuilderStepInput[] | undefined = steps
    let effectiveName = name
    let effectiveDescription = description
    let effectiveTriggerType = trigger_type
    let effectiveTriggerConfig = trigger_config

    if (template && (!steps || steps.length === 0)) {
      const t = getTemplate(template)
      if (t) {
        effectiveName = effectiveName ?? t.name
        effectiveDescription = effectiveDescription ?? t.description
        effectiveTriggerType = effectiveTriggerType ?? t.trigger_type
        effectiveTriggerConfig = effectiveTriggerConfig ?? t.trigger_config
        effectiveSteps = t.steps as unknown as BuilderStepInput[]
      }
    }

    if (!effectiveName || !effectiveTriggerType) {
      return NextResponse.json({ error: 'name and trigger_type are required' }, { status: 400 })
    }

    if (is_active) {
      const issues = [
        ...validateTriggerForActivation(effectiveTriggerType, effectiveTriggerConfig ?? {}),
        ...validateStepsForActivation(
          (effectiveSteps ?? []) as unknown as { step_type: string; step_config: Record<string, unknown> }[],
        ),
      ]
      if (issues.length > 0) {
        return NextResponse.json(
          { error: 'Cannot activate automation with invalid configuration', issues },
          { status: 400 },
        )
      }
    }

    const [automation] = await ctx.db
      .insert(automations)
      .values({
        userId: ctx.userId,
        accountId: ctx.accountId,
        name: effectiveName,
        description: effectiveDescription ?? null,
        triggerType: effectiveTriggerType,
        triggerConfig: effectiveTriggerConfig ?? {},
        isActive: !!is_active,
      })
      .returning(automationSelect)

    if (!automation) return NextResponse.json({ error: 'insert failed' }, { status: 500 })

    if (effectiveSteps && effectiveSteps.length > 0) {
      const err = await insertSteps(automation.id, effectiveSteps)
      if (err) return NextResponse.json({ error: err }, { status: 500 })
    }

    return NextResponse.json({ automation }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
