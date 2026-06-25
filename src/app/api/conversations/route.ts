import { NextResponse } from 'next/server'
import { and, desc, eq, gt, ilike, or } from 'drizzle-orm'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { contacts, conversations } from '@/lib/db/schema'

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

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const url = new URL(request.url)
    const search = url.searchParams.get('search')?.trim()
    const status = url.searchParams.get('status') ?? url.searchParams.get('filter')

    const filters = [eq(conversations.accountId, ctx.accountId)]
    if (status === 'unread') {
      filters.push(gt(conversations.unreadCount, 0))
    } else if (status && status !== 'all') {
      filters.push(eq(conversations.status, status))
    }
    if (search) {
      const pattern = `%${search}%`
      filters.push(
        or(
          ilike(contacts.name, pattern),
          ilike(contacts.phone, pattern),
          ilike(conversations.lastMessageText, pattern),
        )!,
      )
    }

    const rows = await ctx.db
      .select(conversationSelect)
      .from(conversations)
      .innerJoin(contacts, eq(conversations.contactId, contacts.id))
      .where(and(...filters))
      .orderBy(desc(conversations.lastMessageAt))

    return NextResponse.json({ conversations: rows })
  } catch (err) {
    return toErrorResponse(err)
  }
}
