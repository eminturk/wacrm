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

const broadcastSelect = {
  id: broadcasts.id,
  user_id: broadcasts.userId,
  account_id: broadcasts.accountId,
  name: broadcasts.name,
  template_name: broadcasts.templateName,
  template_language: broadcasts.templateLanguage,
  template_variables: broadcasts.templateVariables,
  audience_filter: broadcasts.audienceFilter,
  scheduled_at: broadcasts.scheduledAt,
  status: broadcasts.status,
  total_recipients: broadcasts.totalRecipients,
  sent_count: broadcasts.sentCount,
  delivered_count: broadcasts.deliveredCount,
  read_count: broadcasts.readCount,
  replied_count: broadcasts.repliedCount,
  failed_count: broadcasts.failedCount,
  created_at: broadcasts.createdAt,
  updated_at: broadcasts.updatedAt,
};

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

type CreateBroadcastBody = {
  name?: string;
  template_name?: string;
  template_language?: string;
  template_variables?: Record<string, unknown>;
  audience_filter?: Record<string, unknown>;
  scheduled_at?: string | null;
  status?: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed';
  contactIds?: string[];
};

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const rows = await db
      .select(broadcastSelect)
      .from(broadcasts)
      .where(eq(broadcasts.accountId, ctx.accountId))
      .orderBy(desc(broadcasts.createdAt));

    return NextResponse.json({ broadcasts: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request
      .json()
      .catch(() => null)) as CreateBroadcastBody | null;
    const name = body?.name?.trim();
    const templateName = body?.template_name?.trim();

    if (!name) {
      return NextResponse.json(
        { error: 'Broadcast name is required' },
        { status: 400 }
      );
    }
    if (!templateName) {
      return NextResponse.json(
        { error: 'Template name is required' },
        { status: 400 }
      );
    }

    const requestedContactIds = Array.isArray(body?.contactIds)
      ? [...new Set(body.contactIds.filter(Boolean))]
      : [];

    const result = await db.transaction(async (tx) => {
      let scopedContactIds: string[] = [];
      if (requestedContactIds.length > 0) {
        const rows = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.accountId, ctx.accountId),
              inArray(contacts.id, requestedContactIds)
            )
          );
        scopedContactIds = rows.map((row) => row.id);
      }

      const [broadcast] = await tx
        .insert(broadcasts)
        .values({
          userId: ctx.userId,
          accountId: ctx.accountId,
          name,
          templateName,
          templateLanguage: body?.template_language || 'en_US',
          templateVariables: body?.template_variables ?? {},
          audienceFilter: body?.audience_filter ?? {},
          scheduledAt: body?.scheduled_at ? new Date(body.scheduled_at) : null,
          status: body?.status ?? 'draft',
          totalRecipients: scopedContactIds.length,
          sentCount: 0,
          deliveredCount: 0,
          readCount: 0,
          repliedCount: 0,
          failedCount: 0,
        })
        .returning(broadcastSelect);

      if (!broadcast) throw new Error('Failed to create broadcast');

      if (scopedContactIds.length > 0) {
        const INSERT_CHUNK = 200;
        for (let i = 0; i < scopedContactIds.length; i += INSERT_CHUNK) {
          await tx.insert(broadcastRecipients).values(
            scopedContactIds.slice(i, i + INSERT_CHUNK).map((contactId) => ({
              broadcastId: broadcast.id,
              contactId,
              status: 'pending',
            }))
          );
        }
      }

      const recipients = scopedContactIds.length
        ? await tx
            .select({ recipient: recipientSelect, contact: contactSelect })
            .from(broadcastRecipients)
            .innerJoin(contacts, eq(broadcastRecipients.contactId, contacts.id))
            .where(eq(broadcastRecipients.broadcastId, broadcast.id))
        : [];

      return {
        broadcast,
        recipients: recipients.map((row) => ({
          ...row.recipient,
          contact: row.contact,
        })),
      };
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
