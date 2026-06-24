import { NextResponse } from 'next/server'
import { and, asc, eq, lte } from 'drizzle-orm'
import { db } from '@/lib/db'
import { automationPendingExecutions } from '@/lib/db/schema'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'

export async function GET(request: Request) {
  try {
    const expected = process.env.AUTOMATION_CRON_SECRET
    if (!expected) {
      return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
    }
    const supplied = request.headers.get('x-cron-secret')
    if (supplied !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const due = await db
      .select({
        id: automationPendingExecutions.id,
        automation_id: automationPendingExecutions.automationId,
        account_id: automationPendingExecutions.accountId,
        user_id: automationPendingExecutions.userId,
        contact_id: automationPendingExecutions.contactId,
        log_id: automationPendingExecutions.logId,
        parent_step_id: automationPendingExecutions.parentStepId,
        branch: automationPendingExecutions.branch,
        next_step_position: automationPendingExecutions.nextStepPosition,
        context: automationPendingExecutions.context,
      })
      .from(automationPendingExecutions)
      .where(
        and(
          eq(automationPendingExecutions.status, 'pending'),
          lte(automationPendingExecutions.runAt, new Date()),
        ),
      )
      .orderBy(asc(automationPendingExecutions.runAt))
      .limit(50)

    if (due.length === 0) return NextResponse.json({ processed: 0 })

    let processed = 0
    for (const row of due) {
      const claim = await db
        .update(automationPendingExecutions)
        .set({ status: 'running' })
        .where(
          and(
            eq(automationPendingExecutions.id, row.id),
            eq(automationPendingExecutions.status, 'pending'),
          ),
        )
        .returning({ id: automationPendingExecutions.id })
      if (!claim[0]) continue

      await resumePendingExecution({
        id: row.id as string,
        automation_id: row.automation_id as string,
        account_id: row.account_id as string,
        user_id: row.user_id as string,
        contact_id: (row.contact_id as string | null) ?? null,
        log_id: (row.log_id as string | null) ?? null,
        parent_step_id: (row.parent_step_id as string | null) ?? null,
        branch: (row.branch as 'yes' | 'no' | null) ?? null,
        next_step_position: row.next_step_position as number,
        context: (row.context as AutomationContext) ?? {},
      })
      processed++
    }

    return NextResponse.json({ processed })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
