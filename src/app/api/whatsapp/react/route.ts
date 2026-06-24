/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { db, sql } from '@/lib/db';
import { getSession } from '@/lib/auth/session';
import { sendReactionMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

type DbRow = Record<string, any>;

async function resolveAccountId(userId: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT account_id
    FROM profiles
    WHERE user_id = ${userId}
    LIMIT 1
  `)) as DbRow[];
  return rows[0]?.account_id ?? null;
}

/**
 * POST /api/whatsapp/react
 *
 * Body: { message_id: <internal UUID>, emoji: <single emoji or "" to remove> }
 *
 * Sends the reaction to Meta and mirrors it into `message_reactions`
 * (delete on empty emoji). Customer-side reactions are handled by the
 * webhook — this route only writes `actor_type = 'agent'` rows.
 */
export async function POST(request: Request) {
  try {
    const user = await getSession();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const limit = checkRateLimit(`react:${user.id}`, RATE_LIMITS.react);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    // Resolve the caller's account_id so conversation + whatsapp_config
    // lookups work for teammates who didn't author the rows directly.
    const accountId = await resolveAccountId(user.id);
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { message_id, emoji } = body as {
      message_id?: string;
      emoji?: string;
    };

    if (!message_id || typeof emoji !== 'string') {
      return NextResponse.json(
        { error: 'message_id and emoji are required' },
        { status: 400 },
      );
    }

    // Resolve target message + its conversation; verify ownership.
    const targetRows = (await db.execute(sql`
      SELECT m.id, m.message_id, m.conversation_id
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = ${message_id}
        AND c.account_id = ${accountId}
      LIMIT 1
    `)) as DbRow[];
    const targetMessage = targetRows[0];

    if (!targetMessage) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    if (!targetMessage.message_id) {
      // No Meta ID yet — usually a sending/failed agent message. We can't
      // tell Meta to react to a message it never received.
      return NextResponse.json(
        { error: 'Cannot react to a message that has not been sent to WhatsApp' },
        { status: 400 },
      );
    }

    const conversationRows = (await db.execute(sql`
      SELECT c.id, c.account_id, row_to_json(ct.*) AS contact
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.id = ${targetMessage.conversation_id}
        AND c.account_id = ${accountId}
      LIMIT 1
    `)) as DbRow[];
    const conversation = conversationRows[0];

    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 },
      );
    }

    const contact = Array.isArray(conversation.contact)
      ? conversation.contact[0]
      : conversation.contact;
    if (!contact?.phone) {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 },
      );
    }

    // WhatsApp config + access token. Account-scoped post-multi-user.
    const configRows = (await db.execute(sql`
      SELECT phone_number_id, access_token
      FROM whatsapp_config
      WHERE account_id = ${accountId}
      LIMIT 1
    `)) as DbRow[];
    const config = configRows[0];

    if (!config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured.' },
        { status: 400 },
      );
    }

    const accessToken = decrypt(config.access_token);
    const sanitizedPhone = sanitizePhoneForMeta(contact.phone);

    try {
      await sendReactionMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: sanitizedPhone,
        targetMessageId: targetMessage.message_id,
        emoji,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown Meta API error';
      console.error('[whatsapp/react] Meta send failed:', message);
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 502 },
      );
    }

    // Mirror into DB. Empty emoji = removal.
    if (emoji === '') {
      try {
        await db.execute(sql`
          DELETE FROM message_reactions
          WHERE message_id = ${targetMessage.id}
            AND actor_type = 'agent'
            AND actor_id = ${user.id}
        `);
      } catch (delError) {
        console.error(
          '[whatsapp/react] DB delete failed:',
          delError instanceof Error ? delError.message : delError,
        );
        return NextResponse.json(
          { error: 'Reaction sent to Meta but DB delete failed' },
          { status: 500 },
        );
      }
    } else {
      // Upsert. The unique constraint (message_id, actor_type, actor_id)
      // lets us swap emoji in a single statement.
      try {
        await db.execute(sql`
          INSERT INTO message_reactions (
            message_id,
            conversation_id,
            actor_type,
            actor_id,
            emoji
          ) VALUES (
            ${targetMessage.id},
            ${targetMessage.conversation_id},
            'agent',
            ${user.id},
            ${emoji}
          )
          ON CONFLICT (message_id, actor_type, actor_id)
          DO UPDATE SET emoji = EXCLUDED.emoji, created_at = NOW()
        `);
      } catch (upsertError) {
        console.error(
          '[whatsapp/react] DB upsert failed:',
          upsertError instanceof Error ? upsertError.message : upsertError,
        );
        return NextResponse.json(
          { error: 'Reaction sent to Meta but DB upsert failed' },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error in WhatsApp react POST:', error);
    return NextResponse.json(
      { error: 'Failed to react to message' },
      { status: 500 },
    );
  }
}
