import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendTextMessage,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
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
// Drizzle helpers shared by the text/media/interactive senders.
// ------------------------------------------------------------

type EngineContact = { id: string; phone: string }
type EngineWhatsappConfig = { phone_number_id: string; access_token: string }

async function loadContact(accountId: string, contactId: string): Promise<EngineContact> {
  let contact: EngineContact | undefined
  try {
    ;[contact] = await db
      .select({ id: contacts.id, phone: contacts.phone })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
      .limit(1)
  } catch {
    // Preserve previous PostgREST behavior: lookup errors surface as not found.
  }
  if (!contact?.phone) {
    throw new Error('contact not found for this account')
  }
  return contact
}

async function loadWhatsappConfig(accountId: string): Promise<EngineWhatsappConfig> {
  let config: EngineWhatsappConfig | undefined
  try {
    ;[config] = await db
      .select({
        phone_number_id: whatsappConfig.phoneNumberId,
        access_token: whatsappConfig.accessToken,
      })
      .from(whatsappConfig)
      .where(eq(whatsappConfig.accountId, accountId))
      .limit(1)
  } catch {
    // Match prior `.single()` handling: callers get the configured error.
  }
  if (!config) {
    throw new Error('WhatsApp not configured for this account')
  }
  return config
}

async function persistWorkingPhone(args: {
  accountId: string
  contactId: string
  phone: string
}): Promise<void> {
  try {
    await db
      .update(contacts)
      .set({ phone: args.phone, updatedAt: new Date() })
      .where(and(eq(contacts.id, args.contactId), eq(contacts.accountId, args.accountId)))
  } catch {
    // Previous PostgREST calls ignored this best-effort normalization error.
  }
}

async function persistBotMessage(args: {
  conversationId: string
  contentType: string
  contentText: string | null
  messageId: string
}): Promise<void> {
  try {
    await db.insert(messages).values({
      conversationId: args.conversationId,
      senderType: 'bot',
      contentType: args.contentType,
      contentText: args.contentText,
      messageId: args.messageId,
      status: 'sent',
    })
  } catch (err) {
    throw new Error(`sent to Meta but DB insert failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function updateConversationPreview(args: {
  accountId: string
  conversationId: string
  text: string
}): Promise<void> {
  try {
    await db
      .update(conversations)
      .set({
        lastMessageText: args.text,
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(conversations.id, args.conversationId), eq(conversations.accountId, args.accountId)))
  } catch {
    // Previous PostgREST calls ignored conversation preview update errors.
  }
}

// ------------------------------------------------------------
// Flows-side Meta sender (interactive variants).
//
// Mirrors src/lib/automations/meta-send.ts (engineSendText /
// engineSendTemplate) but emits interactive button + list messages.
// Kept separate from the automations file so the two engines don't
// fight over each other's shape — once both stabilize, the
// phone-variant retry + DB persistence are obvious extraction
// candidates into a shared base.
//
// PR #1 ships this in isolation: callers don't exist yet. PR #2
// brings the flow runner online and wires it up. Shipping it now
// keeps the foundation PR self-contained and unit-testable.
// ------------------------------------------------------------

interface SendTextEngineArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so a flow authored by user A still sends through the
   *  WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the flow — used for INSERT audit columns
   *  and for resolving the agent's identity in logs. Not consulted
   *  for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
}

/**
 * Send a plain-text WhatsApp message from the Flows engine.
 *
 * Used by the runner's `send_message` and `collect_input` nodes —
 * both prompt the customer with text and either auto-advance (the
 * send_message case) or suspend awaiting a text reply (collect_input).
 *
 * Wraps the same phone-variant retry + DB persistence pattern as the
 * interactive senders; the duplication will be DRY'd into a shared
 * `engineSendBase` once the v2 features (templates with variables,
 * media sends) settle.
 */
export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const contact = await loadContact(args.accountId, args.contactId)

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const config = await loadWhatsappConfig(args.accountId)

  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    const r = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: args.text,
    })
    return r.messageId
  }

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
    await persistWorkingPhone({ accountId: args.accountId, contactId: contact.id, phone: workingPhone })
  }

  await persistBotMessage({
    conversationId: args.conversationId,
    contentType: 'text',
    contentText: args.text,
    messageId: waMessageId,
  })

  await updateConversationPreview({
    accountId: args.accountId,
    conversationId: args.conversationId,
    text: args.text,
  })

  return { whatsapp_message_id: waMessageId }
}

interface SendMediaEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  kind: MediaKind
  /** Public URL Meta fetches at send time. */
  link: string
  caption?: string
  /** Document-only; ignored by Meta for image/video. */
  filename?: string
}

/**
 * Send an image / video / document from the Flows engine.
 *
 * Used by the runner's `send_media` node. Auto-advances after the
 * send lands (same suspend semantics as send_message). Same
 * phone-variant retry + DB persistence as the text/interactive
 * senders; persists the outgoing message with `content_type` matching
 * the media kind so the inbox renders the right preview.
 */
export async function engineSendMedia(
  args: SendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const contact = await loadContact(args.accountId, args.contactId)

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const config = await loadWhatsappConfig(args.accountId)

  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    const r = await sendMediaMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
    })
    return r.messageId
  }

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
    await persistWorkingPhone({ accountId: args.accountId, contactId: contact.id, phone: workingPhone })
  }

  // content_type='image'|'video'|'document' — these are already in the
  // messages_content_type_check constraint (migration 001 + 010).
  // content_text carries the caption (or empty) so the conversation
  // list preview shows something meaningful when the user glances at it.
  const preview = args.caption?.trim() || `[${args.kind}]`
  await persistBotMessage({
    conversationId: args.conversationId,
    contentType: args.kind,
    contentText: args.caption ?? null,
    messageId: waMessageId,
  })

  await updateConversationPreview({
    accountId: args.accountId,
    conversationId: args.conversationId,
    text: preview,
  })

  return { whatsapp_message_id: waMessageId }
}

interface SendInteractiveButtonsEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
}

/**
 * Send an interactive-button WhatsApp message from the Flows engine.
 *
 * Persists the outgoing message to `messages` with
 * `content_type='interactive'` and `sender_type='bot'` so the inbox
 * surfaces it with the "Button reply" affordance and the conversation
 * thread reflects the bot's prompt.
 *
 * Returns the Meta message id so the caller (engine) can stash it on
 * the `flow_runs.last_prompt_message_id` field for later reference.
 */
export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'buttons' })
}

/**
 * Send an interactive-list WhatsApp message from the Flows engine.
 * Used when the flow needs more than 3 options (Meta's button cap).
 */
export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'list' })
}

type SendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' })

async function sendInteractiveViaMeta(
  input: SendInput,
): Promise<{ whatsapp_message_id: string }> {
  // Scope the contact + whatsapp_config lookups by account_id —
  // same defense-in-depth rationale as automations/meta-send.ts.
  // Migration 017 moved both tables to account-scoped tenancy.
  const contact = await loadContact(input.accountId, input.contactId)

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const config = await loadWhatsappConfig(input.accountId)

  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'buttons') {
      const r = await sendInteractiveButtons({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        bodyText: input.bodyText,
        buttons: input.buttons,
        headerText: input.headerText,
        footerText: input.footerText,
      })
      return r.messageId
    }
    const r = await sendInteractiveList({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      bodyText: input.bodyText,
      buttonLabel: input.buttonLabel,
      sections: input.sections,
      headerText: input.headerText,
      footerText: input.footerText,
    })
    return r.messageId
  }

  // Same phone-variant retry as automations/meta-send.ts. Numbers
  // registered with/without a trunk 0 + Meta's sandbox quirks all
  // need this to reliably land a message.
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
    await persistWorkingPhone({ accountId: input.accountId, contactId: contact.id, phone: workingPhone })
  }

  // Persist the bot's prompt to the messages table so it appears in
  // the inbox. content_type='interactive' is supported as of
  // migration 010; sender_type='bot' distinguishes flow sends from
  // manual agent sends (the conversation list preview will pick up
  // last_message_text as a sensible summary).
  //
  // We do NOT set interactive_reply_id here — that column is reserved
  // for the customer's tap on this message, populated by the webhook
  // when their reply arrives.
  await persistBotMessage({
    conversationId: input.conversationId,
    contentType: 'interactive',
    contentText: input.bodyText,
    messageId: waMessageId,
  })

  await updateConversationPreview({
    accountId: input.accountId,
    conversationId: input.conversationId,
    text: input.bodyText,
  })

  return { whatsapp_message_id: waMessageId }
}
