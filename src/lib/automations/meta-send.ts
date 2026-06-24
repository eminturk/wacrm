import { sendTextMessage, sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { and, eq } from 'drizzle-orm'
import { db } from './admin-client'
import { contacts, conversations, messages, whatsappConfig } from '@/lib/db/schema'

// ------------------------------------------------------------
// Automation-side Meta sender.
//
// Mirrors the logic in src/app/api/whatsapp/send/route.ts but uses
// the service-role client (engine has no cookies) and accepts the
// user / conversation / contact identifiers the engine already has
// on hand. Kept here (rather than refactoring the user-facing send
// route) to avoid risk to the working manual-send path — they can
// converge in a later refactor.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so an automation authored by user A still sends through
   *  the WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the automation/flow — used for INSERT audit
   *  columns (messages.sender_id-ish) and for resolving the agent's
   *  identity in logs. Not consulted for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
}

interface SendTemplateArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  params?: string[]
}

export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'template' })
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

async function sendViaMeta(input: SendInput): Promise<{ whatsapp_message_id: string }> {
  // Scope the contact + config lookups by account_id, not user_id.
  // The engine uses the service-role client (bypassing RLS); without
  // this filter, an authenticated user could fire their own
  // automations against another tenant's contact UUID and send via
  // their own WhatsApp config to that contact's phone. The 017
  // migration moved both tables to account-scoped tenancy, so the
  // check is the same defense-in-depth as before, just keyed on the
  // new tenancy column.
  let contact: { id: string; phone: string | null } | undefined
  try {
    ;[contact] = await db
      .select({ id: contacts.id, phone: contacts.phone })
      .from(contacts)
      .where(and(eq(contacts.id, input.contactId), eq(contacts.accountId, input.accountId)))
      .limit(1)
  } catch {
    // Preserve the previous PostgREST behavior: any lookup error is
    // indistinguishable from a missing tenant-scoped contact to callers.
  }
  if (!contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  let config:
    | {
        phone_number_id: string
        access_token: string
      }
    | undefined
  try {
    ;[config] = await db
      .select({
        phone_number_id: whatsappConfig.phoneNumberId,
        access_token: whatsappConfig.accessToken,
      })
      .from(whatsappConfig)
      .where(eq(whatsappConfig.accountId, input.accountId))
      .limit(1)
  } catch {
    // Match prior `.single()` handling: callers get the configured error.
  }
  if (!config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const r = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: input.templateName,
        language: input.language,
        params: input.params,
      })
      return r.messageId
    }
    const r = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: input.text,
    })
    return r.messageId
  }

  // Same phone-variant retry as /api/whatsapp/send — Meta sandbox and
  // numbers registered with/without a trunk 0 both require this to
  // reliably land a message.
  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    try {
      await db
        .update(contacts)
        .set({ phone: workingPhone, updatedAt: new Date() })
        .where(and(eq(contacts.id, contact.id), eq(contacts.accountId, input.accountId)))
    } catch {
      // Previous PostgREST call ignored this best-effort normalization error.
    }
  }

  // Persist the sent message so it appears in the inbox with a real
  // Meta message id. sender_type='bot' distinguishes automation sends
  // from manual agent sends.
  const content_type = input.kind === 'template' ? 'template' : 'text'
  const content_text = input.kind === 'text' ? input.text : null
  const template_name = input.kind === 'template' ? input.templateName : null

  try {
    await db.insert(messages).values({
      conversationId: input.conversationId,
      senderType: 'bot',
      contentType: content_type,
      contentText: content_text,
      templateName: template_name,
      messageId: waMessageId,
      status: 'sent',
    })
  } catch (err) {
    // Meta already has the message; record the DB error but don't pretend
    // the send failed. The engine wraps this in a log line.
    throw new Error(`sent to Meta but DB insert failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    await db
      .update(conversations)
      .set({
        lastMessageText:
          input.kind === 'template' ? `[template:${input.templateName}]` : input.text,
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(conversations.id, input.conversationId), eq(conversations.accountId, input.accountId)))
  } catch {
    // Previous PostgREST call ignored conversation preview update errors.
  }

  return { whatsapp_message_id: waMessageId }
}
