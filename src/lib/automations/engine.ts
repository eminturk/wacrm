import { and, asc, count, eq, gte, isNull } from 'drizzle-orm'
import { adminDb as db, sql } from '@/lib/db/admin'
import {
  accounts,
  automations,
  automationLogs,
  automationPendingExecutions,
  automationSteps,
  contactCustomValues,
  contacts,
  contactTags,
  conversations,
  customFields,
  deals,
  profiles,
} from '@/lib/db/schema'
import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  SendMessageStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  AssignConversationStepConfig,
} from '@/types'
import { engineSendText, engineSendTemplate } from './meta-send'

export interface AutomationContext {
  message_text?: string
  conversation_id?: string
  vars?: Record<string, unknown>
  tag_id?: string
  agent_id?: string
}

export interface DispatchInput {
  accountId: string
  triggerType: AutomationTriggerType
  contactId?: string | null
  context?: AutomationContext
}

const automationSelect = {
  id: automations.id,
  account_id: automations.accountId,
  user_id: automations.userId,
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

const stepSelect = {
  id: automationSteps.id,
  automation_id: automationSteps.automationId,
  parent_step_id: automationSteps.parentStepId,
  branch: automationSteps.branch,
  step_type: automationSteps.stepType,
  step_config: automationSteps.stepConfig,
  position: automationSteps.position,
  created_at: automationSteps.createdAt,
}

const contactFieldColumns = {
  name: contacts.name,
  email: contacts.email,
  company: contacts.company,
} as const

export async function runAutomationsForTrigger(input: DispatchInput): Promise<void> {
  try {
    if (input.contactId) {
      const [owned] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, input.contactId), eq(contacts.accountId, input.accountId)))
        .limit(1)
      if (!owned) {
        console.warn('[automations] contact not in account, refusing dispatch', input.contactId)
        return
      }
    }

    const rows = await db
      .select(automationSelect)
      .from(automations)
      .where(
        and(
          eq(automations.accountId, input.accountId),
          eq(automations.triggerType, input.triggerType),
          eq(automations.isActive, true),
        ),
      )

    if (rows.length === 0) return

    for (const automation of rows as unknown as Automation[]) {
      if (!triggerMatches(automation, input.context)) continue
      try {
        await executeAutomation(automation, input)
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err)
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err)
  }
}

export async function resumePendingExecution(pending: {
  id: string
  automation_id: string
  user_id: string
  account_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  context: AutomationContext
}): Promise<void> {
  const [automation] = await db
    .select(automationSelect)
    .from(automations)
    .where(and(eq(automations.id, pending.automation_id), eq(automations.accountId, pending.account_id)))
    .limit(1)

  if (!automation) {
    console.error('[automations] resume: missing automation', pending.automation_id)
    await markPending(pending.id, 'failed')
    return
  }

  try {
    await executeStepsFrom({
      automation: automation as unknown as Automation,
      contactId: pending.contact_id,
      context: pending.context ?? {},
      parentStepId: pending.parent_step_id,
      branch: pending.branch,
      startPosition: pending.next_step_position,
      logId: pending.log_id,
      triggerEvent: 'resumed_wait',
    })
    await markPending(pending.id, 'done')
  } catch (err) {
    console.error('[automations] resume failed:', err)
    await markPending(pending.id, 'failed')
  }
}

async function executeAutomation(automation: Automation, input: DispatchInput) {
  const [log] = await db
    .insert(automationLogs)
    .values({
      automationId: automation.id,
      accountId: automation.account_id,
      userId: automation.user_id,
      contactId: input.contactId ?? null,
      triggerEvent: input.triggerType,
      stepsExecuted: [],
      status: 'success',
    })
    .returning({ id: automationLogs.id })

  if (!log) {
    console.error('[automations] cannot create log')
    return
  }

  await executeStepsFrom({
    automation,
    contactId: input.contactId ?? null,
    context: input.context ?? {},
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.id,
    triggerEvent: input.triggerType,
  })

  try {
    await db.execute(sql`SELECT increment_automation_execution_count(${automation.id}::uuid)`)
  } catch (err) {
    console.error('[automations] increment counter failed:', err)
  }
}

interface ExecuteArgs {
  automation: Automation
  contactId: string | null
  context: AutomationContext
  parentStepId: string | null
  branch: 'yes' | 'no' | null
  startPosition: number
  logId: string | null
  triggerEvent: string
}

async function executeStepsFrom(args: ExecuteArgs): Promise<void> {
  const conditions = [
    eq(automationSteps.automationId, args.automation.id),
    gte(automationSteps.position, args.startPosition),
    args.parentStepId === null
      ? isNull(automationSteps.parentStepId)
      : and(
          eq(automationSteps.parentStepId, args.parentStepId),
          eq(automationSteps.branch, args.branch ?? 'yes'),
        ),
  ]

  let steps: AutomationStep[]
  try {
    steps = (await db
      .select(stepSelect)
      .from(automationSteps)
      .where(and(...conditions))
      .orderBy(asc(automationSteps.position))) as unknown as AutomationStep[]
  } catch (err) {
    await finalizeLog(args.logId, 'failed', err instanceof Error ? err.message : String(err))
    return
  }

  if (steps.length === 0) {
    if (args.parentStepId === null && args.logId) {
      await finalizeLog(args.logId, 'success', null)
    }
    return
  }

  const results: AutomationLogStepResult[] = []
  let status: 'success' | 'partial' | 'failed' = 'success'
  let errorMessage: string | null = null

  for (const step of steps) {
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig
      const ms = waitMs(cfg)
      await db.insert(automationPendingExecutions).values({
        automationId: args.automation.id,
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        contactId: args.contactId,
        logId: args.logId,
        parentStepId: args.parentStepId,
        branch: args.branch,
        nextStepPosition: step.position + 1,
        context: args.context,
        runAt: new Date(Date.now() + ms),
        status: 'pending',
      })
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      })
      status = 'partial'
      await appendResults(args.logId, results, status, errorMessage)
      return
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig
        const taken = await evaluateCondition(cfg, args)
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        })
        await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
        })
        continue
      }

      const detail = await runStep(step, args)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      })
      status = 'failed'
      errorMessage = msg
      break
    }
  }

  if (args.parentStepId === null) {
    await appendResults(args.logId, results, status, errorMessage)
  } else {
    await appendResults(args.logId, results, null, errorMessage)
  }
}

async function runStep(step: AutomationStep, args: ExecuteArgs): Promise<string> {
  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig
      if (!args.contactId) throw new Error('send_message needs a contact')
      const text = interpolate(cfg.text, args)
      if (!text.trim()) throw new Error('send_message has empty text')
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      })
      return `sent via Meta (${whatsapp_message_id})`
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig
      if (!args.contactId) throw new Error('send_template needs a contact')
      if (!cfg.template_name) throw new Error('send_template needs template_name')
      const conversationId = await resolveConversationId(args)
      const params = cfg.variables
        ? Object.keys(cfg.variables)
            .sort((a, b) => {
              const na = Number(a)
              const nb = Number(b)
              const aNum = Number.isFinite(na)
              const bNum = Number.isFinite(nb)
              if (aNum && bNum) return na - nb
              if (aNum) return -1
              if (bNum) return 1
              return a.localeCompare(b)
            })
            .map((k) => String(cfg.variables![k]))
        : []
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
      })
      return `template sent via Meta (${whatsapp_message_id})`
    }

    case 'add_tag': {
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('add_tag needs contact + tag_id')
      await db
        .insert(contactTags)
        .values({ contactId: args.contactId, tagId: cfg.tag_id })
        .onConflictDoNothing({ target: [contactTags.contactId, contactTags.tagId] })
      return `tag ${cfg.tag_id} added`
    }

    case 'remove_tag': {
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('remove_tag needs contact + tag_id')
      await db
        .delete(contactTags)
        .where(and(eq(contactTags.contactId, args.contactId), eq(contactTags.tagId, cfg.tag_id)))
      return `tag ${cfg.tag_id} removed`
    }

    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig
      if (!args.contactId) throw new Error('assign_conversation needs a contact')
      let agentId = cfg.agent_id
      if (cfg.mode === 'round_robin') {
        const rows = await db
          .select({ user_id: profiles.userId })
          .from(profiles)
          .where(eq(profiles.accountId, args.automation.account_id))
          .limit(1)
        agentId = rows[0]?.user_id
      }
      if (!agentId) return 'no agent resolved'
      await db
        .update(conversations)
        .set({ assignedAgentId: agentId })
        .where(
          and(
            eq(conversations.accountId, args.automation.account_id),
            eq(conversations.contactId, args.contactId),
          ),
        )
      return `assigned to ${agentId}`
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig
      if (!args.contactId) throw new Error('update_contact_field needs a contact')
      const value = interpolate(cfg.value, args)

      if (cfg.field.startsWith('custom:')) {
        const customFieldId = cfg.field.slice('custom:'.length)
        if (!customFieldId) return `field ${cfg.field} not writable from automations`
        const [field] = await db
          .select({ id: customFields.id })
          .from(customFields)
          .where(
            and(
              eq(customFields.id, customFieldId),
              eq(customFields.accountId, args.automation.account_id),
            ),
          )
          .limit(1)
        if (!field) return `field ${cfg.field} not writable from automations`
        await db
          .insert(contactCustomValues)
          .values({ contactId: args.contactId, customFieldId, value })
          .onConflictDoUpdate({
            target: [contactCustomValues.contactId, contactCustomValues.customFieldId],
            set: { value },
          })
        return `custom field updated`
      }

      const column = contactFieldColumns[cfg.field as keyof typeof contactFieldColumns]
      if (!column) return `field ${cfg.field} not writable from automations`
      await db
        .update(contacts)
        .set({ [column.name]: value, updatedAt: new Date() } as Partial<typeof contacts.$inferInsert>)
        .where(and(eq(contacts.id, args.contactId), eq(contacts.accountId, args.automation.account_id)))
      return `${cfg.field} updated`
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig
      if (!cfg.pipeline_id || !cfg.stage_id) throw new Error('create_deal needs pipeline + stage')
      const [acct] = await db
        .select({ default_currency: accounts.defaultCurrency })
        .from(accounts)
        .where(eq(accounts.id, args.automation.account_id))
        .limit(1)
      await db.insert(deals).values({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        pipelineId: cfg.pipeline_id,
        stageId: cfg.stage_id,
        contactId: args.contactId,
        title: interpolate(cfg.title, args),
        value: String(cfg.value ?? 0),
        currency: acct?.default_currency ?? 'USD',
        status: 'open',
      })
      return 'deal created'
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig
      if (!cfg.url) throw new Error('send_webhook needs url')
      const body = cfg.body_template ? interpolate(cfg.body_template, args) : JSON.stringify(args.context)
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
      })
      if (!res.ok) throw new Error(`webhook returned ${res.status}`)
      return `webhook ${res.status}`
    }

    case 'close_conversation': {
      if (!args.contactId) throw new Error('close_conversation needs a contact')
      await db
        .update(conversations)
        .set({ status: 'closed', updatedAt: new Date() })
        .where(
          and(
            eq(conversations.accountId, args.automation.account_id),
            eq(conversations.contactId, args.contactId),
          ),
        )
      return 'conversation closed'
    }

    default:
      return `unknown step: ${step.step_type}`
  }
}

async function resolveConversationId(args: ExecuteArgs): Promise<string> {
  const fromCtx = args.context.conversation_id
  if (fromCtx) return fromCtx
  if (!args.contactId) throw new Error('cannot resolve conversation: no contact')
  const [data] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.accountId, args.automation.account_id),
        eq(conversations.contactId, args.contactId),
      ),
    )
    .limit(1)
  if (!data?.id) throw new Error('no conversation for contact')
  return data.id as string
}

function triggerMatches(automation: Automation, ctx: AutomationContext | undefined): boolean {
  if (automation.trigger_type !== 'keyword_match') return true
  const cfg = automation.trigger_config as KeywordMatchTriggerConfig
  if (!cfg?.keywords || cfg.keywords.length === 0) return false
  const text = (ctx?.message_text ?? '').toString()
  if (!text) return false
  const haystack = cfg.case_sensitive ? text : text.toLowerCase()
  return cfg.keywords.some((raw) => {
    const k = cfg.case_sensitive ? raw : raw.toLowerCase()
    return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k)
  })
}

async function evaluateCondition(cfg: ConditionStepConfig, args: ExecuteArgs): Promise<boolean> {
  switch (cfg.subject) {
    case 'tag_presence': {
      if (!args.contactId || !cfg.operand) return false
      const [{ c }] = await db
        .select({ c: count() })
        .from(contactTags)
        .where(and(eq(contactTags.contactId, args.contactId), eq(contactTags.tagId, cfg.operand)))
      return (c ?? 0) > 0
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false
      const column = contactFieldColumns[cfg.operand as keyof typeof contactFieldColumns]
      if (!column) return false
      const [data] = await db
        .select({ value: column })
        .from(contacts)
        .where(and(eq(contacts.id, args.contactId), eq(contacts.accountId, args.automation.account_id)))
        .limit(1)
      const v = data?.value
      return v != null && String(v) === String(cfg.value ?? '')
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString()
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase())
    }
    case 'time_of_day': {
      const [from, to] = (cfg.operand ?? '').split('-')
      if (!from || !to) return false
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number)
        return (h || 0) * 60 + (m || 0)
      }
      const f = parse(from)
      const t = parse(to)
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t
    }
    default:
      return false
  }
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs = cfg.unit === 'days' ? 86_400_000 : cfg.unit === 'hours' ? 3_600_000 : 60_000
  return Math.max(1_000, cfg.amount * unitMs)
}

function interpolate(s: string, args: ExecuteArgs): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.')
    if (ns === 'message' && prop === 'text') return String(args.context.message_text ?? '')
    if (ns === 'vars' && prop) return String(args.context.vars?.[prop] ?? '')
    return ''
  })
}

async function appendResults(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed' | null,
  errorMessage: string | null,
) {
  if (!logId) return
  const [existing] = await db
    .select({ steps_executed: automationLogs.stepsExecuted, status: automationLogs.status })
    .from(automationLogs)
    .where(eq(automationLogs.id, logId))
    .limit(1)
  const merged = [
    ...((existing?.steps_executed as AutomationLogStepResult[] | undefined) ?? []),
    ...newItems,
  ]
  const update: Partial<typeof automationLogs.$inferInsert> = { stepsExecuted: merged }
  if (status !== null) update.status = status
  if (errorMessage) update.errorMessage = errorMessage
  await db.update(automationLogs).set(update).where(eq(automationLogs.id, logId))
}

async function finalizeLog(
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null,
) {
  if (!logId) return
  await db
    .update(automationLogs)
    .set({ status, errorMessage })
    .where(eq(automationLogs.id, logId))
}

async function markPending(id: string, status: 'done' | 'failed') {
  await db
    .update(automationPendingExecutions)
    .set({ status })
    .where(eq(automationPendingExecutions.id, id))
}
