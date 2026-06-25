import { NextResponse } from 'next/server'
import { and, desc, eq } from 'drizzle-orm'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { automationLogs, automations, contacts } from '@/lib/db/schema'

export const runtime = 'nodejs'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const ctx = await getCurrentAccount()
    const [automation] = await ctx.db
      .select({
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
      })
      .from(automations)
      .where(and(eq(automations.id, id), eq(automations.accountId, ctx.accountId)))
      .limit(1)

    if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const rows = await ctx.db
      .select({
        id: automationLogs.id,
        automation_id: automationLogs.automationId,
        user_id: automationLogs.userId,
        account_id: automationLogs.accountId,
        contact_id: automationLogs.contactId,
        trigger_event: automationLogs.triggerEvent,
        steps_executed: automationLogs.stepsExecuted,
        status: automationLogs.status,
        error_message: automationLogs.errorMessage,
        created_at: automationLogs.createdAt,
        contact: contacts,
      })
      .from(automationLogs)
      .leftJoin(contacts, eq(automationLogs.contactId, contacts.id))
      .where(and(eq(automationLogs.accountId, ctx.accountId), eq(automationLogs.automationId, id)))
      .orderBy(desc(automationLogs.createdAt))
      .limit(100)

    const logs = rows.map((r) => ({
      ...r,
      contact: r.contact
        ? {
            id: r.contact.id,
            user_id: r.contact.userId,
            account_id: r.contact.accountId,
            phone: r.contact.phone,
            phone_normalized: r.contact.phoneNormalized,
            name: r.contact.name,
            email: r.contact.email,
            company: r.contact.company,
            avatar_url: r.contact.avatarUrl,
            created_at: r.contact.createdAt,
            updated_at: r.contact.updatedAt,
          }
        : null,
    }))

    return NextResponse.json({ automation, logs })
  } catch (err) {
    return toErrorResponse(err)
  }
}
