import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account'
import { contacts, conversations } from '@/lib/db/schema'
import type { ConversationStatus } from '@/types'

export const runtime = 'nodejs'

const conversationSelect = {
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
  contact: {
    id: contacts.id,
    user_id: contacts.userId,
    account_id: contacts.accountId,
    phone: contacts.phone,
    phone_normalized: contacts.phoneNormalized,
    name: contacts.name,
    email: contacts.email,
    company: contacts.company,
    avatar_url: contacts.avatarUrl,
    created_at: contacts.createdAt,
    updated_at: contacts.updatedAt,
  },
}

async function fetchConversation(
  id: string,
  accountId: string,
  database: AccountContext['db'],
) {
  const [conversation] = await database
    .select(conversationSelect)
    .from(conversations)
    .innerJoin(contacts, eq(conversations.contactId, contacts.id))
    .where(and(eq(conversations.id, id), eq(conversations.accountId, accountId)))
    .limit(1)
  return conversation
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentAccount()
    const { id } = await params
    const conversation = await fetchConversation(id, ctx.accountId, ctx.db)
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }
    return NextResponse.json({ conversation })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as
      | {
          status?: ConversationStatus
          assigned_agent_id?: string | null
          assignedAgentId?: string | null
          unread_count?: number
          mark_read?: boolean
        }
      | null

    const update: Partial<typeof conversations.$inferInsert> = { updatedAt: new Date() }
    if (body?.mark_read || body?.unread_count === 0) update.unreadCount = 0
    if (body?.status) update.status = body.status
    if ('assigned_agent_id' in (body ?? {})) update.assignedAgentId = body?.assigned_agent_id ?? null
    if ('assignedAgentId' in (body ?? {})) update.assignedAgentId = body?.assignedAgentId ?? null

    if (Object.keys(update).length === 1) {
      return NextResponse.json({ error: 'No supported fields to update' }, { status: 400 })
    }

    const [updated] = await ctx.db
      .update(conversations)
      .set(update)
      .where(and(eq(conversations.id, id), eq(conversations.accountId, ctx.accountId)))
      .returning({ id: conversations.id })

    if (!updated) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const conversation = await fetchConversation(id, ctx.accountId, ctx.db)
    return NextResponse.json({ conversation })
  } catch (err) {
    return toErrorResponse(err)
  }
}
