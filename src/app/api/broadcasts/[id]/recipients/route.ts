import { NextResponse } from 'next/server';
import { and, desc, eq, inArray } from 'drizzle-orm';

import { db } from '@/lib/db';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { broadcasts, broadcastRecipients, contacts } from '@/lib/db/schema';

export const runtime = 'nodejs';

const contactSelect = {
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
};

const recipientSelect = {
  id: broadcastRecipients.id,
  broadcast_id: broadcastRecipients.broadcastId,
  contact_id: broadcastRecipients.contactId,
  status: broadcastRecipients.status,
  whatsapp_message_id: broadcastRecipients.whatsappMessageId,
  sent_at: broadcastRecipients.sentAt,
  delivered_at: broadcastRecipients.deliveredAt,
  read_at: broadcastRecipients.readAt,
  replied_at: broadcastRecipients.repliedAt,
  error_message: broadcastRecipients.errorMessage,
  created_at: broadcastRecipients.createdAt,
};

const STATUSES = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
  'failed',
] as const;

type RecipientUpdate = {
  id: string;
  status: string;
  whatsapp_message_id?: string | null;
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  replied_at?: string | null;
  error_message?: string | null;
};

function summarize(rows: { status: string }[]) {
  const counts = Object.fromEntries(
    STATUSES.map((status) => [status, 0])
  ) as Record<string, number>;
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return { total: rows.length, counts };
}

async function ensureBroadcast(accountId: string, id: string) {
  const [broadcast] = await db
    .select({ id: broadcasts.id })
    .from(broadcasts)
    .where(and(eq(broadcasts.id, id), eq(broadcasts.accountId, accountId)))
    .limit(1);
  return broadcast;
}

async function refreshBroadcastCounts(id: string) {
  const rows = await db
    .select({ status: broadcastRecipients.status })
    .from(broadcastRecipients)
    .where(eq(broadcastRecipients.broadcastId, id));
  const summary = summarize(rows);
  await db
    .update(broadcasts)
    .set({
      totalRecipients: summary.total,
      sentCount:
        summary.counts.sent +
        summary.counts.delivered +
        summary.counts.read +
        summary.counts.replied,
      deliveredCount:
        summary.counts.delivered + summary.counts.read + summary.counts.replied,
      readCount: summary.counts.read + summary.counts.replied,
      repliedCount: summary.counts.replied,
      failedCount: summary.counts.failed,
      updatedAt: new Date(),
    })
    .where(eq(broadcasts.id, id));
  return summary;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const broadcast = await ensureBroadcast(ctx.accountId, id);
    if (!broadcast) {
      return NextResponse.json(
        { error: 'Broadcast not found' },
        { status: 404 }
      );
    }

    const rows = await db
      .select({ recipient: recipientSelect, contact: contactSelect })
      .from(broadcastRecipients)
      .leftJoin(contacts, eq(broadcastRecipients.contactId, contacts.id))
      .where(eq(broadcastRecipients.broadcastId, id))
      .orderBy(desc(broadcastRecipients.createdAt));

    const recipients = rows.map((row) => ({
      ...row.recipient,
      contact: row.contact,
    }));
    return NextResponse.json({ recipients, summary: summarize(recipients) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    const broadcast = await ensureBroadcast(ctx.accountId, id);
    if (!broadcast) {
      return NextResponse.json(
        { error: 'Broadcast not found' },
        { status: 404 }
      );
    }

    const body = (await request.json().catch(() => null)) as {
      updates?: RecipientUpdate[];
    } | null;
    const updates =
      body?.updates?.filter((update) => update.id && update.status) ?? [];
    if (updates.length === 0) {
      return NextResponse.json(
        { error: 'No recipient updates provided' },
        { status: 400 }
      );
    }

    const allowedRows = await db
      .select({ id: broadcastRecipients.id })
      .from(broadcastRecipients)
      .where(
        and(
          eq(broadcastRecipients.broadcastId, id),
          inArray(
            broadcastRecipients.id,
            updates.map((update) => update.id)
          )
        )
      );
    const allowedIds = new Set(allowedRows.map((row) => row.id));

    for (const update of updates) {
      if (!allowedIds.has(update.id)) continue;
      await db
        .update(broadcastRecipients)
        .set({
          status: update.status,
          whatsappMessageId: update.whatsapp_message_id ?? null,
          sentAt: update.sent_at
            ? new Date(update.sent_at)
            : update.status === 'sent'
              ? new Date()
              : undefined,
          deliveredAt: update.delivered_at
            ? new Date(update.delivered_at)
            : undefined,
          readAt: update.read_at ? new Date(update.read_at) : undefined,
          repliedAt: update.replied_at
            ? new Date(update.replied_at)
            : undefined,
          errorMessage: update.error_message ?? null,
        })
        .where(eq(broadcastRecipients.id, update.id));
    }

    const summary = await refreshBroadcastCounts(id);
    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    return toErrorResponse(err);
  }
}
