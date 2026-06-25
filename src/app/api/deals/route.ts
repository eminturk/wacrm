import { NextResponse } from 'next/server'
import { and, desc, eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { contacts, conversations, deals, pipelineStages, pipelines, profiles } from '@/lib/db/schema'

export const runtime = 'nodejs'

type DealRow = {
  id: string
  user_id: string
  account_id: string | null
  pipeline_id: string
  stage_id: string
  contact_id: string | null
  conversation_id: string | null
  assigned_to: string | null
  title: string
  value: string | number
  currency: string | null
  notes: string | null
  expected_close_date: string | null
  status: string | null
  created_at: Date | string | null
  updated_at: Date | string | null
  contact: typeof contacts.$inferSelect | null
  assignee: typeof profiles.$inferSelect | null
}

const dealBaseSelect = {
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

function serializeDate(value: Date | string | null | undefined) {
  return value instanceof Date ? value.toISOString() : (value ?? null)
}

function contactToJson(c: typeof contacts.$inferSelect | null | undefined) {
  return c
    ? {
        id: c.id,
        user_id: c.userId,
        account_id: c.accountId,
        phone: c.phone,
        phone_normalized: c.phoneNormalized,
        name: c.name,
        email: c.email,
        company: c.company,
        avatar_url: c.avatarUrl,
        created_at: serializeDate(c.createdAt),
        updated_at: serializeDate(c.updatedAt),
      }
    : null
}

function profileToJson(p: typeof profiles.$inferSelect | null | undefined) {
  return p
    ? {
        id: p.id,
        user_id: p.userId,
        full_name: p.fullName,
        email: p.email,
        avatar_url: p.avatarUrl,
        role: p.role,
        beta_features: p.betaFeatures ?? [],
        account_id: p.accountId,
        account_role: p.accountRole,
        created_at: serializeDate(p.createdAt),
        updated_at: serializeDate(p.updatedAt),
      }
    : null
}

function dealToJson(row: DealRow) {
  return {
    id: row.id,
    user_id: row.user_id,
    account_id: row.account_id,
    pipeline_id: row.pipeline_id,
    stage_id: row.stage_id,
    contact_id: row.contact_id,
    conversation_id: row.conversation_id,
    assigned_to: row.assigned_to,
    title: row.title,
    value: Number(row.value ?? 0),
    currency: row.currency,
    notes: row.notes,
    expected_close_date: row.expected_close_date,
    status: row.status,
    created_at: serializeDate(row.created_at),
    updated_at: serializeDate(row.updated_at),
    contact: contactToJson(row.contact),
    assignee: profileToJson(row.assignee),
  }
}

async function pipelineBelongsToAccount(pipelineId: string, accountId: string) {
  const [row] = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(eq(pipelines.id, pipelineId), eq(pipelines.accountId, accountId)))
    .limit(1)
  return !!row
}

async function stageBelongsToPipeline(stageId: string, pipelineId: string) {
  const [row] = await db
    .select({ id: pipelineStages.id })
    .from(pipelineStages)
    .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, pipelineId)))
    .limit(1)
  return !!row
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const url = new URL(request.url)

    if (url.searchParams.get('support') === 'deal-form') {
      const [contactRows, profileRows] = await Promise.all([
        db.select().from(contacts).where(eq(contacts.accountId, ctx.accountId)).orderBy(contacts.name),
        db.select().from(profiles).where(eq(profiles.accountId, ctx.accountId)).orderBy(profiles.fullName),
      ])
      return NextResponse.json({
        contacts: contactRows.map(contactToJson),
        profiles: profileRows.map(profileToJson),
      })
    }

    const contactId = url.searchParams.get('contact_id')
    if (contactId) {
      const [conversation] = await db
        .select({
          id: conversations.id,
          user_id: conversations.userId,
          account_id: conversations.accountId,
          contact_id: conversations.contactId,
          status: conversations.status,
          assigned_agent_id: conversations.assignedAgentId,
          last_message_text: conversations.lastMessageText,
          last_message_at: conversations.lastMessageAt,
          unread_count: conversations.unreadCount,
          created_at: conversations.createdAt,
          updated_at: conversations.updatedAt,
        })
        .from(conversations)
        .where(and(eq(conversations.accountId, ctx.accountId), eq(conversations.contactId, contactId)))
        .orderBy(desc(conversations.lastMessageAt))
        .limit(1)
      return NextResponse.json({ conversation: conversation ?? null })
    }

    const pipelineId = url.searchParams.get('pipeline_id')
    if (!pipelineId) return NextResponse.json({ error: 'pipeline_id is required' }, { status: 400 })
    if (!(await pipelineBelongsToAccount(pipelineId, ctx.accountId))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const rows = await db
      .select({ ...dealBaseSelect, contact: contacts, assignee: profiles })
      .from(deals)
      .leftJoin(contacts, eq(deals.contactId, contacts.id))
      .leftJoin(profiles, eq(deals.assignedTo, profiles.id))
      .where(and(eq(deals.accountId, ctx.accountId), eq(deals.pipelineId, pipelineId)))
      .orderBy(desc(deals.createdAt))
    return NextResponse.json({ deals: rows.map((r) => dealToJson(r as DealRow)) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = await request.json().catch(() => ({}))
    const title = String(body.title ?? '').trim()
    const pipelineId = String(body.pipeline_id ?? '')
    const stageId = String(body.stage_id ?? '')
    const contactId = String(body.contact_id ?? '')

    if (!title || !contactId || !stageId || !pipelineId) {
      return NextResponse.json({ error: 'Title, contact, and stage are required' }, { status: 400 })
    }
    if (!(await pipelineBelongsToAccount(pipelineId, ctx.accountId)) || !(await stageBelongsToPipeline(stageId, pipelineId))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)))
      .limit(1)
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

    const [latestConversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.accountId, ctx.accountId), eq(conversations.contactId, contactId)))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1)

    const [deal] = await db
      .insert(deals)
      .values({
        userId: ctx.userId,
        accountId: ctx.accountId,
        title,
        value: String(Number(body.value ?? 0) || 0),
        currency: body.currency ?? 'USD',
        contactId,
        conversationId: latestConversation?.id ?? null,
        pipelineId,
        stageId,
        assignedTo: body.assigned_to || null,
        notes: body.notes || null,
        expectedCloseDate: body.expected_close_date || null,
        status: 'open',
      })
      .returning(dealBaseSelect)
    return NextResponse.json({ deal }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
