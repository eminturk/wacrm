import type { db as appDb } from '@/lib/db'
import { and, asc, count, desc, eq, gte, lt } from 'drizzle-orm'
import { getCurrentAccount } from '@/lib/auth/account'
import {
  automations,
  automationLogs,
  broadcasts,
  contacts,
  conversations,
  deals,
  messages,
  pipelines,
  pipelineStages,
} from '@/lib/db/schema'
import {
  daysAgoStart,
  DOW_SHORT_MON_FIRST,
  lastNDayKeys,
  localDayKey,
  mondayIndex,
  startOfLocalDay,
} from './date-utils'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  PipelineStageSlice,
  ResponseTimeBucket,
  ResponseTimeSummary,
} from './types'

// ------------------------------------------------------------
// Server-side dashboard aggregations. Standalone Postgres has no
// PostgREST/RLS layer, so every query is explicitly scoped to the
// caller's account_id resolved from the cookie session.
// ------------------------------------------------------------

type DB = typeof appDb

async function getAccountId(): Promise<string> {
  const ctx = await getCurrentAccount()
  return ctx.accountId
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  return typeof value === 'number' ? value : Number(value) || 0
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString()
  return value instanceof Date ? value.toISOString() : value
}

// --- 1. Metric cards ---------------------------------------------------

export async function loadMetrics(db: DB): Promise<MetricsBundle> {
  const accountId = await getAccountId()
  const todayStart = startOfLocalDay()
  const yesterdayStart = daysAgoStart(1)

  const [
    openConvCur,
    newConvToday,
    newConvYesterday,
    newContactsToday,
    newContactsYesterday,
    openDeals,
    messagesToday,
    messagesYesterday,
  ] = await Promise.all([
    db
      .select({ c: count() })
      .from(conversations)
      .where(and(eq(conversations.accountId, accountId), eq(conversations.status, 'open'))),
    db
      .select({ c: count() })
      .from(conversations)
      .where(
        and(
          eq(conversations.accountId, accountId),
          eq(conversations.status, 'open'),
          gte(conversations.createdAt, todayStart),
        ),
      ),
    db
      .select({ c: count() })
      .from(conversations)
      .where(
        and(
          eq(conversations.accountId, accountId),
          eq(conversations.status, 'open'),
          gte(conversations.createdAt, yesterdayStart),
          lt(conversations.createdAt, todayStart),
        ),
      ),
    db
      .select({ c: count() })
      .from(contacts)
      .where(and(eq(contacts.accountId, accountId), gte(contacts.createdAt, todayStart))),
    db
      .select({ c: count() })
      .from(contacts)
      .where(
        and(
          eq(contacts.accountId, accountId),
          gte(contacts.createdAt, yesterdayStart),
          lt(contacts.createdAt, todayStart),
        ),
      ),
    db
      .select({ value: deals.value })
      .from(deals)
      .where(and(eq(deals.accountId, accountId), eq(deals.status, 'open'))),
    db
      .select({ c: count() })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(
        and(
          eq(conversations.accountId, accountId),
          eq(messages.senderType, 'agent'),
          gte(messages.createdAt, todayStart),
        ),
      ),
    db
      .select({ c: count() })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(
        and(
          eq(conversations.accountId, accountId),
          eq(messages.senderType, 'agent'),
          gte(messages.createdAt, yesterdayStart),
          lt(messages.createdAt, todayStart),
        ),
      ),
  ])

  const openDealsValue = openDeals.reduce((sum, d) => sum + toNumber(d.value), 0)

  return {
    activeConversations: {
      current: openConvCur[0]?.c ?? 0,
      // "vs yesterday" on a current-state count has no clean answer
      // without snapshots — we show the delta in NEW open conversations
      // today vs yesterday. That's the business-meaningful daily signal.
      previous: (newConvToday[0]?.c ?? 0) - (newConvYesterday[0]?.c ?? 0),
    },
    newContactsToday: {
      current: newContactsToday[0]?.c ?? 0,
      previous: newContactsYesterday[0]?.c ?? 0,
    },
    openDealsValue,
    openDealsCount: openDeals.length,
    messagesSentToday: {
      current: messagesToday[0]?.c ?? 0,
      previous: messagesYesterday[0]?.c ?? 0,
    },
  }
}

// --- 2. Conversations over time ---------------------------------------

export async function loadConversationsSeries(
  db: DB,
  rangeDays: number,
): Promise<ConversationsSeriesPoint[]> {
  const accountId = await getAccountId()
  const start = daysAgoStart(rangeDays - 1)
  const data = await db
    .select({ createdAt: messages.createdAt, senderType: messages.senderType })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(eq(conversations.accountId, accountId), gte(messages.createdAt, start)))
    .orderBy(asc(messages.createdAt))

  const keys = lastNDayKeys(rangeDays)
  const buckets = new Map<string, { incoming: number; outgoing: number }>()
  for (const k of keys) buckets.set(k, { incoming: 0, outgoing: 0 })

  for (const row of data) {
    if (!row.createdAt) continue
    const key = localDayKey(row.createdAt)
    const bucket = buckets.get(key)
    if (!bucket) continue
    if (row.senderType === 'customer') bucket.incoming += 1
    else bucket.outgoing += 1 // agent + bot both count as outgoing
  }

  return keys.map((day) => ({ day, ...(buckets.get(day) ?? { incoming: 0, outgoing: 0 }) }))
}

// --- 3. Pipeline donut -------------------------------------------------

export async function loadPipelineDonut(db: DB): Promise<PipelineDonutData> {
  const accountId = await getAccountId()
  const [stages, openDeals] = await Promise.all([
    db
      .select({
        id: pipelineStages.id,
        name: pipelineStages.name,
        color: pipelineStages.color,
      })
      .from(pipelineStages)
      .innerJoin(pipelines, eq(pipelineStages.pipelineId, pipelines.id))
      .where(eq(pipelines.accountId, accountId))
      .orderBy(asc(pipelineStages.position)),
    db
      .select({ stageId: deals.stageId, value: deals.value })
      .from(deals)
      .where(and(eq(deals.accountId, accountId), eq(deals.status, 'open'))),
  ])

  const byStage = new Map<string, { count: number; total: number }>()
  for (const d of openDeals) {
    const row = byStage.get(d.stageId) ?? { count: 0, total: 0 }
    row.count += 1
    row.total += toNumber(d.value)
    byStage.set(d.stageId, row)
  }

  const slices: PipelineStageSlice[] = stages
    .map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color || '#64748b',
      dealCount: byStage.get(s.id)?.count ?? 0,
      totalValue: byStage.get(s.id)?.total ?? 0,
    }))
    // Hide empty stages from the ring (but we'd still show them in the
    // legend if the user wanted a full breakdown — trimming keeps the
    // visual clean for the common case).
    .filter((s) => s.totalValue > 0 || s.dealCount > 0)

  return {
    stages: slices,
    totalValue: slices.reduce((sum, s) => sum + s.totalValue, 0),
  }
}

// --- 4. Response time by day of week ----------------------------------

export async function loadResponseTime(db: DB): Promise<ResponseTimeSummary> {
  const accountId = await getAccountId()
  // Pull the last 14 days of messages in one shot, then walk per
  // conversation to find each "first inbound" → "first subsequent
  // outbound" pair. 14 days gives us both "this week" + "last week"
  // with enough overlap if the user opens the dashboard late on a
  // Monday.
  const fourteenDaysAgo = daysAgoStart(13)
  const rows = await db
    .select({
      conversationId: messages.conversationId,
      senderType: messages.senderType,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(eq(conversations.accountId, accountId), gte(messages.createdAt, fourteenDaysAgo)))
    .orderBy(asc(messages.conversationId), asc(messages.createdAt))

  // Group per conversation, pair unreplied customer messages with the
  // next outbound message from the agent/bot. A single customer message
  // can only count once (avoids inflating averages if the customer
  // double-messages while the agent takes time to reply).
  interface Sample {
    customerAt: Date
    responseAt: Date
  }
  const samples: Sample[] = []

  let currentConv = ''
  let pendingCustomer: Date | null = null
  for (const row of rows) {
    if (row.conversationId !== currentConv) {
      currentConv = row.conversationId
      pendingCustomer = null
    }
    if (!row.createdAt) continue
    const ts = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt)
    if (row.senderType === 'customer') {
      if (!pendingCustomer) pendingCustomer = ts
    } else if (pendingCustomer) {
      samples.push({ customerAt: pendingCustomer, responseAt: ts })
      pendingCustomer = null
    }
  }

  const now = new Date()
  const thisWeekStart = daysAgoStart(mondayIndex(now))
  const lastWeekStart = daysAgoStart(mondayIndex(now) + 7)

  // Per-day-of-week buckets, averaged over both weeks' worth of data
  // so each bar has more samples to stand on. If a day has no samples
  // its avgMinutes stays null and the chart renders the bar muted.
  const byDow = new Map<number, number[]>()
  for (let i = 0; i < 7; i++) byDow.set(i, [])
  const thisWeekMins: number[] = []
  const lastWeekMins: number[] = []

  for (const s of samples) {
    const diffMin = (s.responseAt.getTime() - s.customerAt.getTime()) / 60_000
    if (diffMin < 0) continue
    const dow = mondayIndex(s.customerAt)
    byDow.get(dow)!.push(diffMin)
    if (s.customerAt >= thisWeekStart) {
      thisWeekMins.push(diffMin)
    } else if (s.customerAt >= lastWeekStart && s.customerAt < thisWeekStart) {
      lastWeekMins.push(diffMin)
    }
  }

  const avg = (arr: number[]) =>
    arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length

  const buckets: ResponseTimeBucket[] = Array.from({ length: 7 }, (_, dow) => {
    const samples = byDow.get(dow) ?? []
    return {
      dow,
      avgMinutes: avg(samples),
      samples: samples.length,
    }
  })

  // Silence unused-label warnings — keep the arrays explicitly named
  // for readability above.
  void DOW_SHORT_MON_FIRST

  return {
    buckets,
    thisWeekAvg: avg(thisWeekMins),
    lastWeekAvg: avg(lastWeekMins),
  }
}

// --- 5. Activity feed --------------------------------------------------

export async function loadActivity(db: DB, limit = 20): Promise<ActivityItem[]> {
  const accountId = await getAccountId()
  // Pull ~10 from each source (plenty of headroom after merge-sort),
  // then interleave by timestamp. The individual per-table limits
  // keep the payload small; the final limit is enforced after sort.
  const [msgs, newContacts, updatedDeals, recentBroadcasts, autoLogs] = await Promise.all([
    db
      .select({
        id: messages.id,
        createdAt: messages.createdAt,
        conversationId: messages.conversationId,
        contactName: contacts.name,
        contactPhone: contacts.phone,
      })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .leftJoin(contacts, eq(conversations.contactId, contacts.id))
      .where(and(eq(conversations.accountId, accountId), eq(messages.senderType, 'customer')))
      .orderBy(desc(messages.createdAt))
      .limit(10),
    db
      .select({ id: contacts.id, name: contacts.name, phone: contacts.phone, createdAt: contacts.createdAt })
      .from(contacts)
      .where(eq(contacts.accountId, accountId))
      .orderBy(desc(contacts.createdAt))
      .limit(10),
    db
      .select({
        id: deals.id,
        title: deals.title,
        updatedAt: deals.updatedAt,
        stageName: pipelineStages.name,
      })
      .from(deals)
      .leftJoin(pipelineStages, eq(deals.stageId, pipelineStages.id))
      .where(eq(deals.accountId, accountId))
      .orderBy(desc(deals.updatedAt))
      .limit(10),
    db
      .select({
        id: broadcasts.id,
        name: broadcasts.name,
        status: broadcasts.status,
        totalRecipients: broadcasts.totalRecipients,
        createdAt: broadcasts.createdAt,
      })
      .from(broadcasts)
      .where(eq(broadcasts.accountId, accountId))
      .orderBy(desc(broadcasts.createdAt))
      .limit(5),
    db
      .select({
        id: automationLogs.id,
        triggerEvent: automationLogs.triggerEvent,
        status: automationLogs.status,
        createdAt: automationLogs.createdAt,
        automationName: automations.name,
        contactName: contacts.name,
        contactPhone: contacts.phone,
      })
      .from(automationLogs)
      .leftJoin(automations, eq(automationLogs.automationId, automations.id))
      .leftJoin(contacts, eq(automationLogs.contactId, contacts.id))
      .where(eq(automationLogs.accountId, accountId))
      .orderBy(desc(automationLogs.createdAt))
      .limit(10),
  ])

  const items: ActivityItem[] = []

  for (const m of msgs) {
    const who = m.contactName || m.contactPhone || 'Unknown'
    items.push({
      id: `msg-${m.id}`,
      kind: 'message',
      text: `New message from ${who}`,
      at: toIso(m.createdAt),
      href: `/inbox?c=${m.conversationId}`,
    })
  }

  for (const c of newContacts) {
    items.push({
      id: `contact-${c.id}`,
      kind: 'contact',
      text: `New contact: ${c.name || c.phone}`,
      at: toIso(c.createdAt),
      href: '/contacts',
    })
  }

  for (const d of updatedDeals) {
    items.push({
      id: `deal-${d.id}`,
      kind: 'deal',
      text: d.stageName
        ? `Deal "${d.title}" in ${d.stageName}`
        : `Deal "${d.title}" updated`,
      at: toIso(d.updatedAt),
      href: '/pipelines',
    })
  }

  for (const b of recentBroadcasts) {
    const totalRecipients = b.totalRecipients ?? 0
    const label =
      b.status === 'sent'
        ? `sent to ${totalRecipients} contacts`
        : `${b.status} (${totalRecipients} recipients)`
    items.push({
      id: `broadcast-${b.id}`,
      kind: 'broadcast',
      text: `Broadcast "${b.name}" ${label}`,
      at: toIso(b.createdAt),
      href: '/broadcasts',
    })
  }

  for (const l of autoLogs) {
    const who = l.contactName || l.contactPhone || 'a contact'
    const autoName = l.automationName || 'Automation'
    items.push({
      id: `auto-${l.id}`,
      kind: 'automation',
      text: `Automation "${autoName}" ${l.status === 'failed' ? 'failed for' : 'triggered for'} ${who}`,
      at: toIso(l.createdAt),
    })
  }

  return items
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0))
    .slice(0, limit)
}
