/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server'
import { db, sql } from '@/lib/db'
import { getSession } from '@/lib/auth/session'
import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import type { MessageTemplate } from '@/types'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'

type DbRow = Record<string, any>

async function resolveAccountId(userId: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT account_id
    FROM profiles
    WHERE user_id = ${userId}
    LIMIT 1
  `)) as DbRow[]
  return rows[0]?.account_id ?? null
}

export async function POST(request: Request) {
  try {
    const user = await getSession()

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Per-user rate limit. Bucket key is scoped to this route so
    // `/broadcast` has an independent budget.
    const limit = await checkRateLimit(`send:${user.id}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // Resolve the caller's account_id. Every downstream lookup
    // (conversation, whatsapp_config, message_templates) is account-
    // scoped post-multi-user, so the previous `user_id` filters
    // returned nothing for teammates who didn't author the row.
    const accountId = await resolveAccountId(user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const {
      conversation_id,
      message_type,
      content_text,
      media_url,
      filename,
      template_name,
      template_language,
      template_params,
      template_message_params,
      reply_to_message_id,
    } = body

    if (!conversation_id || !message_type) {
      return NextResponse.json(
        { error: 'conversation_id and message_type are required' },
        { status: 400 }
      )
    }

    // Media kinds (image/video/document/audio) are sent to Meta via a
    // public URL the composer already uploaded to the chat-media bucket.
    const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const
    const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(message_type)

    // Reject anything outside the known set up front rather than letting
    // an unknown type fall through to the text path with empty content.
    const VALID_MESSAGE_TYPES = ['text', 'template', ...MEDIA_KINDS] as const
    if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(message_type)) {
      return NextResponse.json(
        { error: `Unsupported message_type "${message_type}"` },
        { status: 400 }
      )
    }

    if (message_type === 'text' && !content_text) {
      return NextResponse.json(
        { error: 'content_text is required for text messages' },
        { status: 400 }
      )
    }

    if (message_type === 'template' && !template_name) {
      return NextResponse.json(
        { error: 'template_name is required for template messages' },
        { status: 400 }
      )
    }

    if (isMediaKind && !media_url) {
      return NextResponse.json(
        { error: `media_url is required for ${message_type} messages` },
        { status: 400 }
      )
    }

    // Meta caps media captions at 1024 chars; reject before the upload is
    // wasted at the Meta call. (Audio carries no caption — see meta-api.)
    if (
      isMediaKind &&
      message_type !== 'audio' &&
      typeof content_text === 'string' &&
      content_text.length > 1024
    ) {
      return NextResponse.json(
        { error: 'Caption exceeds the 1024-character limit' },
        { status: 400 }
      )
    }

    // Fetch conversation and contact
    const conversationRows = (await db.execute(sql`
      SELECT c.*, row_to_json(ct.*) AS contact
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.id = ${conversation_id}
        AND c.account_id = ${accountId}
      LIMIT 1
    `)) as DbRow[]
    const conversation = conversationRows[0]

    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      )
    }

    const contact = conversation.contact
    if (!contact?.phone) {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 }
      )
    }

    // Block sends to opted-out contacts — enforces "opt-out işlemlerini
    // anlık uygulayabilme" from the technical spec.
    if (contact.opted_out) {
      return NextResponse.json(
        { error: 'Contact has opted out of WhatsApp messages and cannot be messaged.' },
        { status: 422 }
      )
    }

    // Sanitize and validate phone
    const sanitizedPhone = sanitizePhoneForMeta(contact.phone)
    if (!isValidE164(sanitizedPhone)) {
      return NextResponse.json(
        { error: 'Invalid phone number format' },
        { status: 400 }
      )
    }

    // Fetch and decrypt WhatsApp config
    const configRows = (await db.execute(sql`
      SELECT *
      FROM whatsapp_config
      WHERE account_id = ${accountId}
      LIMIT 1
    `)) as DbRow[]
    const config = configRows[0]

    if (!config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured. Please set up your WhatsApp integration first.' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Self-heal legacy CBC-encrypted tokens. Fire-and-forget: we
    // return from the send without waiting, so a failed upgrade just
    // means the next send tries again. The upgrade is idempotent —
    // concurrent sends both produce valid GCM ciphertexts of the same
    // plaintext, last write wins.
    if (isLegacyFormat(config.access_token)) {
      void db.execute(sql`
        UPDATE whatsapp_config
        SET access_token = ${encrypt(accessToken)}, updated_at = NOW()
        WHERE id = ${config.id}
      `).catch((error) => {
        console.warn(
          '[whatsapp/send] access_token GCM upgrade failed:',
          error instanceof Error ? error.message : error,
        )
      })
    }

    // Resolve the reply target (if any) to its Meta message_id, which is
    // what `context.message_id` on the outgoing Meta payload needs. The
    // parent must belong to this same conversation — otherwise a caller
    // could quote messages they can't see by guessing UUIDs.
    let contextMessageId: string | undefined
    if (reply_to_message_id) {
      const parentRows = (await db.execute(sql`
        SELECT message_id, conversation_id
        FROM messages
        WHERE id = ${reply_to_message_id}
          AND conversation_id = ${conversation_id}
        LIMIT 1
      `)) as DbRow[]
      const parent = parentRows[0]

      if (!parent) {
        return NextResponse.json(
          { error: 'reply_to_message_id not found in this conversation' },
          { status: 400 }
        )
      }
      if (!parent.message_id) {
        // Parent never reached Meta (still in 'sending' or 'failed') — we
        // can't quote it on WhatsApp. Send without context rather than
        // dropping the message entirely.
        console.warn(
          '[whatsapp/send] reply target has no Meta message_id; sending without context'
        )
      } else {
        contextMessageId = parent.message_id
      }
    }

    // Send via Meta API — retry with phone-number variants if Meta rejects
    // with "recipient not in allowed list" (common in sandbox / when a
    // number was registered with/without a trunk 0). If an alternate
    // format succeeds, we persist it back to the contact row so the
    // next send goes through on the first attempt.
    let waMessageId = ''
    let workingPhone = sanitizedPhone

    // For template sends, load the row so sendTemplateMessage can
    // build header + button components from the template definition.
    // Match on (account_id, name, language) so multi-language templates
    // work correctly. Missing template falls through with `templateRow = null`
    // and the legacy body-only path runs.
    let templateRow: MessageTemplate | null = null
    if (message_type === 'template' && template_name) {
      const templateRows = (await db.execute(sql`
        SELECT *
        FROM message_templates
        WHERE account_id = ${accountId}
          AND name = ${template_name}
          AND language = ${template_language || 'en_US'}
        LIMIT 1
      `)) as DbRow[]
      const data = templateRows[0]
      if (data && !isMessageTemplate(data)) {
        return NextResponse.json(
          {
            error:
              'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
          },
          { status: 500 },
        )
      }
      templateRow = data ?? null
    }

    const attempt = async (phone: string): Promise<string> => {
      if (message_type === 'template') {
        const result = await sendTemplateMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          templateName: template_name,
          language: template_language || 'en_US',
          template: templateRow ?? undefined,
          messageParams: template_message_params ?? undefined,
          // Legacy body-only fallback — only consulted when
          // messageParams.body isn't set.
          params: template_params || [],
          contextMessageId,
        })
        return result.messageId
      }
      if (isMediaKind) {
        // content_text doubles as the caption (ignored for audio inside
        // sendMediaMessage). filename surfaces in the recipient's chat
        // for documents only.
        const result = await sendMediaMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          kind: message_type as MediaKind,
          link: media_url,
          caption: content_text || undefined,
          filename: filename || undefined,
          contextMessageId,
        })
        return result.messageId
      }
      const result = await sendTextMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        text: content_text,
        contextMessageId,
      })
      return result.messageId
    }

    try {
      const variants = phoneVariants(sanitizedPhone)
      let lastError: unknown = null

      for (const variant of variants) {
        try {
          waMessageId = await attempt(variant)
          workingPhone = variant
          lastError = null
          break
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // Only retry when the failure is specifically that the
          // recipient isn't in Meta's allowed list. Any other error
          // (bad token, invalid template, etc.) bubbles up immediately.
          if (!isRecipientNotAllowedError(message)) {
            throw err
          }
          lastError = err
          console.warn(`[whatsapp/send] variant "${variant}" rejected by Meta, trying next…`)
        }
      }

      if (lastError) throw lastError
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('Meta API send failed for all variants:', message)
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 502 }
      )
    }

    // If a non-original variant succeeded, update the contact so future
    // sends go straight through. sanitizePhoneForMeta on workingPhone
    // will yield workingPhone itself, so re-storing preserves it.
    if (workingPhone !== sanitizedPhone) {
      console.log(
        `[whatsapp/send] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`
      )
      await db.execute(sql`
        UPDATE contacts
        SET phone = ${workingPhone}, updated_at = NOW()
        WHERE id = ${contact.id}
          AND account_id = ${accountId}
      `)
    }

    // Insert message into DB — field names MUST match the messages schema:
    //   conversation_id, sender_type, content_type, content_text,
    //   media_url, template_name, message_id, status, created_at
    let messageRecord: DbRow
    try {
      const messageRows = (await db.execute(sql`
        INSERT INTO messages (
          conversation_id,
          sender_type,
          content_type,
          content_text,
          media_url,
          template_name,
          message_id,
          status,
          reply_to_message_id
        ) VALUES (
          ${conversation_id},
          'agent',
          ${message_type},
          ${content_text || null},
          ${media_url || null},
          ${template_name || null},
          ${waMessageId},
          'sent',
          ${reply_to_message_id || null}
        )
        RETURNING *
      `)) as DbRow[]
      messageRecord = messageRows[0]
    } catch (msgError) {
      console.error('Error inserting sent message:', msgError)
      const message = msgError instanceof Error ? msgError.message : String(msgError)
      return NextResponse.json(
        { error: `Message sent to Meta but failed to save to DB: ${message}` },
        { status: 500 }
      )
    }

    // Update conversation
    await db.execute(sql`
      UPDATE conversations
      SET last_message_text = ${content_text || `[${message_type}]`},
          last_message_at = NOW(),
          updated_at = NOW()
      WHERE id = ${conversation_id}
        AND account_id = ${accountId}
    `)

    // Pause any active Flow run for this contact — the agent stepping
    // in is the strongest "yield, human is here" signal. See PR #2
    // plan for why we pause (not end): preserves diagnostic state +
    // lets the agent or the 24h timeout sweep cleanly resolve the
    // run later. For accounts with no active runs the UPDATE matches
    // zero rows — cheap and harmless.
    try {
      await db.execute(sql`
        UPDATE flow_runs
        SET status = 'paused_by_agent',
            ended_at = NOW(),
            end_reason = 'agent_replied'
        WHERE account_id = ${accountId}
          AND contact_id = ${contact.id}
          AND status = 'active'
      `)
    } catch (err) {
      console.error(
        '[flows] pause-on-agent-send threw:',
        err instanceof Error ? err.message : err,
      )
    }

    return NextResponse.json({
      success: true,
      message_id: messageRecord.id,
      whatsapp_message_id: waMessageId,
    })
  } catch (error) {
    console.error('Error in WhatsApp send POST:', error)
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    )
  }
}
