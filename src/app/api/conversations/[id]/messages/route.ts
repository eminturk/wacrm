import { NextResponse } from 'next/server'
import { and, asc, eq, lt } from 'drizzle-orm'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { conversations, messageReactions, messages } from '@/lib/db/schema'

export const runtime = 'nodejs'

const messageSelect = {
  id: messages.id,
  conversation_id: messages.conversationId,
  sender_type: messages.senderType,
  sender_id: messages.senderId,
  content_type: messages.contentType,
  content_text: messages.contentText,
  media_url: messages.mediaUrl,
  template_name: messages.templateName,
  message_id: messages.messageId,
  status: messages.status,
  reply_to_message_id: messages.replyToMessageId,
  interactive_reply_id: messages.interactiveReplyId,
  created_at: messages.createdAt,
}

const reactionSelect = {
  id: messageReactions.id,
  message_id: messageReactions.messageId,
  conversation_id: messageReactions.conversationId,
  actor_type: messageReactions.actorType,
  actor_id: messageReactions.actorId,
  emoji: messageReactions.emoji,
  created_at: messageReactions.createdAt,
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentAccount()
    const { id } = await params
    const [conversation] = await ctx.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.accountId, ctx.accountId)))
      .limit(1)

    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const url = new URL(request.url)
    const before = url.searchParams.get('before')
    const parsedLimit = Number(url.searchParams.get('limit') ?? '')
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : undefined
    const filters = [eq(messages.conversationId, id)]
    if (before) filters.push(lt(messages.createdAt, new Date(before)))

    const query = ctx.db
      .select(messageSelect)
      .from(messages)
      .where(and(...filters))
      .orderBy(asc(messages.createdAt))

    const [messageRows, reactionRows] = await Promise.all([
      limit ? query.limit(limit) : query,
      ctx.db
        .select(reactionSelect)
        .from(messageReactions)
        .where(eq(messageReactions.conversationId, id))
        .orderBy(asc(messageReactions.createdAt)),
    ])

    return NextResponse.json({ messages: messageRows, reactions: reactionRows })
  } catch (err) {
    return toErrorResponse(err)
  }
}
