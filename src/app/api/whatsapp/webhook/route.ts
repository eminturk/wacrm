import { NextResponse } from 'next/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, sql } from '@/lib/db';
import {
  broadcastRecipients,
  broadcasts,
  contacts,
  conversations,
  messages,
  messageReactions,
  whatsappConfig,
} from '@/lib/db/schema';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { getMediaUrl } from '@/lib/whatsapp/meta-api';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook';
import { writeAuditLog } from '@/lib/audit';

/**
 * Meta error codes that indicate the recipient has opted out of
 * marketing/utility messages on WhatsApp.
 *
 * 131026 — Message Undeliverable: recipient blocked the sender.
 * 131031 — Re-engagement message: marketing opt-out triggered.
 */
const OPT_OUT_ERROR_CODES = new Set([131026, 131031]);

interface WhatsAppMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  video?: { id: string; mime_type: string; caption?: string };
  document?: {
    id: string;
    mime_type: string;
    filename?: string;
    caption?: string;
  };
  audio?: { id: string; mime_type: string };
  sticker?: { id: string; mime_type: string };
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  reaction?: { message_id: string; emoji: string };
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string };
}

interface WhatsAppWebhookEntry {
  id: string;
  changes: Array<{
    value: {
      messaging_product: string;
      metadata: {
        display_phone_number: string;
        phone_number_id: string;
      };
      contacts?: Array<{
        profile: { name: string };
        wa_id: string;
      }>;
      messages?: WhatsAppMessage[];
      statuses?: Array<{
        id: string;
        status: string;
        timestamp: string;
        recipient_id: string;
        /** Present on failed/errored statuses. */
        errors?: Array<{ code: number; title?: string; message?: string }>;
      }>;
    };
    field: string;
  }>;
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('hub.mode');
    const challenge = searchParams.get('hub.challenge');
    const verifyToken = searchParams.get('hub.verify_token');

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      );
    }

    // Fetch all whatsapp configs to check verify tokens
    let configs: Array<{ id: string; verifyToken: string | null }>;
    try {
      configs = await db
        .select({
          id: whatsappConfig.id,
          verifyToken: whatsappConfig.verifyToken,
        })
        .from(whatsappConfig);
    } catch (configError) {
      console.error('Error fetching configs for verification:', configError);
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      );
    }

    // Check if any config's verify_token matches. Also collect the
    // matching row so we can opportunistically upgrade its token to
    // GCM if it was still in the legacy CBC format.
    let matchedConfig: { id: string; verifyToken: string | null } | null = null;
    for (const config of configs) {
      if (!config.verifyToken) continue;
      try {
        if (decrypt(config.verifyToken) === verifyToken) {
          matchedConfig = config;
          break;
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      if (
        matchedConfig.verifyToken &&
        isLegacyFormat(matchedConfig.verifyToken)
      ) {
        void db
          .update(whatsappConfig)
          .set({ verifyToken: encrypt(verifyToken) })
          .where(eq(whatsappConfig.id, matchedConfig.id))
          .catch((error: unknown) => {
            console.warn(
              '[webhook] verify_token GCM upgrade failed:',
              (error as { message?: string })?.message ?? error
            );
          });
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    );
  } catch (error) {
    console.error('Error in webhook GET verification:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: { entry?: WhatsAppWebhookEntry[] };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Process asynchronously so we can ack Meta within their timeout.
  processWebhook(body).catch((error) => {
    console.error('Error processing webhook:', error);
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return;

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      // Template-lifecycle events (status / quality / components
      // updates from Meta) come in on a different change.field and
      // have a different value shape — route them through the
      // dedicated handler. Skip the messaging branches below so we
      // don't try to read message-shaped fields off a template event.
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          { field: change.field, value: change.value as unknown },
          db
        );
        continue;
      }

      const value = change.value;

      // Handle status updates
      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status);
        }
      }

      // Handle incoming messages
      if (!value.messages || !value.contacts) continue;

      const phoneNumberId = value.metadata.phone_number_id;

      // Find user's config by phone_number_id. `.single()` returns
      // PGRST116 for both 0 rows AND ≥2 rows — distinguish them so
      // operators see the real cause in logs. ≥2 rows shouldn't happen
      // post-migration 013 (UNIQUE constraint), but a row created
      // before the constraint, or a race, would still surface here.
      let configRows: Array<typeof whatsappConfig.$inferSelect>;
      try {
        configRows = await db
          .select()
          .from(whatsappConfig)
          .where(eq(whatsappConfig.phoneNumberId, phoneNumberId));
      } catch (configError) {
        console.error(
          'Error fetching whatsapp_config for phone_number_id:',
          phoneNumberId,
          configError
        );
        continue;
      }

      if (configRows.length === 0) {
        console.error('No config found for phone_number_id:', phoneNumberId);
        continue;
      }

      if (configRows.length > 1) {
        console.error(
          `Multiple configs (${configRows.length}) found for phone_number_id:`,
          phoneNumberId,
          '— inbound message dropped. Resolve duplicates so each number maps to a single account.',
          'Account owners:',
          configRows.map((r) => `${r.accountId} (admin ${r.userId})`)
        );
        continue;
      }

      const config = configRows[0];

      const decryptedAccessToken = decrypt(config.accessToken);

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i];
        const contact = value.contacts[i] || value.contacts[0];

        await processMessage(
          message,
          contact,
          // Tenancy — drives every contact / conversation lookup
          // and the engines' active-row dispatch.
          config.accountId!,
          // Audit / sender-of-record — used as the user_id on row
          // inserts that need it for NOT NULL FK compliance. Always
          // the admin who saved the WhatsApp config.
          config.userId,
          decryptedAccessToken
        );
      }
    }
  }
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once Meta has
// delivered or the user has read or replied, a later "failed" status
// event is a bug in Meta's pipeline or a spoof attempt and must be
// ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const;

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s);
  return idx < 0 ? -1 : idx;
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent';
  }
  if (current === 'failed') {
    return false; // failed is terminal
  }
  const ci = ladderLevel(current);
  const ii = ladderLevel(incoming);
  if (ii < 0) return false; // unknown incoming status
  if (ci < 0) return true; // unknown current — accept anything on the ladder
  return ii > ci;
}

async function handleStatusUpdate(status: {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  errors?: Array<{ code: number; title?: string; message?: string }>;
}) {
  // Capture the first Meta error code if present
  const errorCode = status.errors?.[0]?.code != null
    ? String(status.errors[0].code)
    : null;

  // 1) Mirror onto messages (legacy behavior) — Meta's status values
  //    already match the CHECK constraint on messages.status.
  try {
    await db
      .update(messages)
      .set({
        status: status.status,
        ...(errorCode ? { errorCode } : {}),
      })
      .where(eq(messages.messageId, status.id));
  } catch (msgErr) {
    console.error('Error updating message status:', msgErr);
  }

  // 2) Opt-out enforcement — if Meta reports an opt-out error code,
  //    mark the contact as opted out immediately so subsequent sends
  //    are blocked without another round-trip to Meta.
  if (status.errors?.some((e) => OPT_OUT_ERROR_CODES.has(e.code))) {
    try {
      // Find the contact by phone (recipient_id is the E.164 number).
      await db
        .update(contacts)
        .set({ optedOut: true, optedOutAt: new Date() })
        .where(eq(contacts.phoneNormalized, status.recipient_id));

      // Audit the opt-out event
      void writeAuditLog({
        action: 'contact.opted_out',
        resourceType: 'contact',
        metadata: {
          phone: status.recipient_id,
          errorCode,
          source: 'webhook',
        },
      });
    } catch (optOutErr) {
      console.error('Error setting opted_out on contact:', optOutErr);
    }
  }

  // 3) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const ts = new Date(parseInt(status.timestamp) * 1000);

  let recipient: { id: string; status: string } | undefined;
  try {
    [recipient] = await db
      .select({
        id: broadcastRecipients.id,
        status: broadcastRecipients.status,
      })
      .from(broadcastRecipients)
      .where(eq(broadcastRecipients.whatsappMessageId, status.id))
      .limit(1);
  } catch (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr);
    return;
  }
  if (!recipient) return; // message wasn't part of a broadcast — fine

  // Guard transitions — forward-only on the success ladder, and
  // `failed` only from pre-delivered states.
  if (!isValidStatusTransition(recipient.status, status.status)) return;

  const update: Partial<typeof broadcastRecipients.$inferInsert> = {
    status: status.status,
    ...(errorCode ? { errorCode } : {}),
  };
  if (status.status === 'sent') update.sentAt = ts;
  if (status.status === 'delivered') update.deliveredAt = ts;
  if (status.status === 'read') update.readAt = ts;

  try {
    await db
      .update(broadcastRecipients)
      .set(update)
      .where(eq(broadcastRecipients.id, recipient.id));
  } catch (recUpdateErr) {
    console.error('Error updating broadcast recipient status:', recUpdateErr);
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const recs = await db
      .select({
        id: broadcastRecipients.id,
        status: broadcastRecipients.status,
        broadcastId: broadcastRecipients.broadcastId,
      })
      .from(broadcastRecipients)
      .innerJoin(broadcasts, eq(broadcastRecipients.broadcastId, broadcasts.id))
      .where(
        and(
          eq(broadcastRecipients.contactId, contactId),
          eq(broadcasts.accountId, accountId),
          inArray(broadcastRecipients.status, ['sent', 'delivered', 'read'])
        )
      )
      .orderBy(desc(broadcastRecipients.createdAt))
      .limit(1);

    if (recs.length === 0) return;

    const row = recs[0];
    await db
      .update(broadcastRecipients)
      .set({ status: 'replied', repliedAt: new Date() })
      .where(eq(broadcastRecipients.id, row.id));
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err);
  }
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  try {
    const [row] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.messageId, metaId),
          eq(messages.conversationId, conversationId)
        )
      )
      .limit(1);
    return row?.id ?? null;
  } catch (error) {
    console.error(
      '[webhook] lookupInternalIdByMetaId failed:',
      (error as { message?: string }).message ?? error
    );
    return null;
  }
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction;
  if (!reaction?.message_id) return;

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  );
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    );
    return;
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    try {
      await db
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, targetInternalId),
            eq(messageReactions.actorType, 'customer'),
            eq(messageReactions.actorId, contactId)
          )
        );
    } catch (delError) {
      console.error(
        '[webhook] reaction delete failed:',
        (delError as { message?: string }).message ?? delError
      );
    }
    return;
  }

  try {
    await db
      .insert(messageReactions)
      .values({
        messageId: targetInternalId,
        conversationId,
        actorType: 'customer',
        actorId: contactId,
        emoji: reaction.emoji,
      })
      .onConflictDoUpdate({
        target: [
          messageReactions.messageId,
          messageReactions.actorType,
          messageReactions.actorId,
        ],
        set: {
          conversationId,
          emoji: reaction.emoji,
        },
      });
  } catch (upsertError) {
    console.error(
      '[webhook] reaction upsert failed:',
      (upsertError as { message?: string }).message ?? upsertError
    );
  }
}

async function processMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
  // Tenancy. Resolved from the matched whatsapp_config row; every
  // contact / conversation / message row created downstream is
  // stamped with this so any member of the account can see it.
  accountId: string,
  // Sender-of-record for inserts that need a NOT NULL user_id FK
  // (contacts, conversations). Always the admin who saved the
  // WhatsApp config; the choice is arbitrary post-017 but stable.
  configOwnerUserId: string,
  accessToken: string
) {
  const senderPhone = normalizePhone(message.from);
  const contactName = contact.profile.name;

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName
  );
  if (!contactOutcome) return;
  const contactRecord = contactOutcome.contact;

  // Find or create conversation
  const conversation = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  );
  if (!conversation) return;

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before parseMessageContent so the media-URL fetch is skipped.
  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id);
    return;
  }

  // Parse message content based on type
  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(message, accessToken);

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null;
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id
    );
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        message.context.id
      );
    }
  }

  // Insert message — field names MUST match the messages table schema
  // (see the initial database schema):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, template_name, message_id, status, created_at
  // `mediaType` is intentionally unused — the schema has no media_type
  // column; the MIME type is only used to construct the proxy URL during
  // parseMessageContent. Silence the unused-var warning:
  void mediaType;

  // The messages.content_type CHECK constraint (widened in migration 010
  // to add 'interactive' for button/list taps) allows:
  //   text, image, document, audio, video, location, template, interactive
  // Map incoming WhatsApp types that aren't in that list to the closest
  // allowed value so the INSERT doesn't fail with a constraint error.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text',
    'image',
    'document',
    'audio',
    'video',
    'location',
    'template',
    'interactive',
  ]);
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image' // stickers are images
      : 'text'; // reaction, unknown → text fallback

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const [{ count: priorCustomerMsgCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversation.id),
        eq(messages.senderType, 'customer')
      )
    );
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0;

  try {
    await db.insert(messages).values({
      conversationId: conversation.id,
      senderType: 'customer',
      contentType,
      contentText,
      mediaUrl,
      messageId: message.id,
      status: 'delivered',
      createdAt: new Date(parseInt(message.timestamp) * 1000),
      replyToMessageId: replyToInternalId,
      // Only populated for content_type='interactive'. Migration 010 added
      // the column; null for every other content_type so existing inserts
      // behave identically.
      interactiveReplyId,
    });
  } catch (msgError) {
    console.error('Error inserting message:', msgError);
    return;
  }

  // Update conversation
  try {
    await db
      .update(conversations)
      .set({
        lastMessageText: contentText || `[${message.type}]`,
        lastMessageAt: new Date(),
        unreadCount: (conversation.unreadCount || 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversation.id));
  } catch (convError) {
    console.error('Error updating conversation:', convError);
  }

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances (via the aggregate
  // trigger installed in migration 003).
  await flagBroadcastReplyIfAny(accountId, contactRecord.id);

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText ?? '',
          meta_message_id: message.id,
        }
      : {
          kind: 'text',
          text: contentText ?? message.text?.body ?? '',
          meta_message_id: message.id,
        },
    isFirstInboundMessage,
  });
  const flowConsumed = flowResult.consumed;

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  // Fire-and-forget: a slow or failing automation must not block the
  // webhook's 200 OK response to Meta.
  const inboundText = contentText ?? message.text?.body ?? '';
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = [];
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match');
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (contactOutcome.wasCreated)
    automationTriggers.unshift('new_contact_created');
  if (isFirstInboundMessage)
    automationTriggers.unshift('first_inbound_message');
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err));
  }
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string
): Promise<{
  contentText: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null;
}> {
  // getMediaUrl signature is (mediaId, accessToken) — earlier code had
  // the args swapped, so every verification hit an invalid Meta URL and
  // fell through to the catch block, leaving mediaUrl as null. That's
  // why images showed up as empty bubbles in the inbox.
  const verifyAndBuildUrl = async (mediaId: string): Promise<string | null> => {
    try {
      await getMediaUrl({ mediaId, accessToken });
      return `/api/whatsapp/media/${mediaId}`;
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      );
      return null;
    }
  };

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  };

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null };

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
        };
      }
      return empty;

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        };
      }
      return empty;

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          mediaUrl: await verifyAndBuildUrl(message.document.id),
          mediaType: message.document.mime_type,
        };
      }
      return empty;

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.audio.id),
          mediaType: message.audio.mime_type,
        };
      }
      return empty;

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. The caller maps the DB
      // content_type to 'image' for the CHECK constraint.
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        };
      }
      return empty;

    case 'location':
      if (message.location) {
        const loc = message.location;
        const locationText = [
          loc.name,
          loc.address,
          `${loc.latitude},${loc.longitude}`,
        ]
          .filter(Boolean)
          .join(' - ');
        return { ...empty, contentText: locationText };
      }
      return empty;

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null };

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply;
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        };
      }
      return { ...empty, contentText: '[Interactive reply]' };
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      };
  }
}

type ContactRow = typeof contacts.$inferSelect;

interface ContactOutcome {
  contact: ContactRow;
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean;
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all three
  // paths agree on what "same number" means (issue #212).
  const existingContact = await findExistingContact(db, accountId, phone);

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await db
        .update(contacts)
        .set({ name, updatedAt: new Date() })
        .where(eq(contacts.id, existingContact.id));
    }
    return { contact: existingContact as ContactRow, wasCreated: false };
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  try {
    const [newContact] = await db
      .insert(contacts)
      .values({
        accountId,
        userId: configOwnerUserId,
        phone,
        name: name || phone,
      })
      .returning();
    return { contact: newContact, wasCreated: true };
  } catch (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(db, accountId, phone);
      if (raced) return { contact: raced as ContactRow, wasCreated: false };
    }
    console.error('Error creating contact:', createError);
    return null;
  }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string
) {
  // Look for existing conversation in this account
  const [existing] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.accountId, accountId),
        eq(conversations.contactId, contactId)
      )
    )
    .limit(1);

  if (existing) {
    return existing;
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  try {
    const [newConv] = await db
      .insert(conversations)
      .values({
        accountId,
        userId: configOwnerUserId,
        contactId,
      })
      .returning();
    return newConv;
  } catch (createError) {
    console.error('Error creating conversation:', createError);
    return null;
  }
}
