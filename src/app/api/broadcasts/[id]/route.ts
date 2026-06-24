import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { broadcasts, broadcastRecipients } from '@/lib/db/schema';

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

const STATUSES = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
  'failed',
] as const;

function summarize(statuses: { status: string }[]) {
  const counts = Object.fromEntries(
    STATUSES.map((status) => [status, 0])
  ) as Record<string, number>;
  for (const row of statuses)
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  return { total: statuses.length, counts };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const [broadcast] = await db
      .select(broadcastSelect)
      .from(broadcasts)
      .where(
        and(eq(broadcasts.id, id), eq(broadcasts.accountId, ctx.accountId))
      )
      .limit(1);

    if (!broadcast) {
      return NextResponse.json(
        { error: 'Broadcast not found' },
        { status: 404 }
      );
    }

    const recipientStatuses = await db
      .select({ status: broadcastRecipients.status })
      .from(broadcastRecipients)
      .where(eq(broadcastRecipients.broadcastId, id));

    return NextResponse.json({
      broadcast,
      recipients_summary: summarize(recipientStatuses),
    });
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
    const body = (await request.json().catch(() => null)) as {
      name?: string;
      status?: string;
      scheduled_at?: string | null;
      template_variables?: Record<string, unknown>;
      audience_filter?: Record<string, unknown>;
      total_recipients?: number;
      sent_count?: number;
      delivered_count?: number;
      read_count?: number;
      replied_count?: number;
      failed_count?: number;
    } | null;

    const patch: Partial<typeof broadcasts.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (body?.name !== undefined) patch.name = body.name.trim();
    if (body?.status !== undefined) patch.status = body.status;
    if (body?.scheduled_at !== undefined) {
      patch.scheduledAt = body.scheduled_at
        ? new Date(body.scheduled_at)
        : null;
    }
    if (body?.template_variables !== undefined)
      patch.templateVariables = body.template_variables;
    if (body?.audience_filter !== undefined)
      patch.audienceFilter = body.audience_filter;
    if (body?.total_recipients !== undefined)
      patch.totalRecipients = body.total_recipients;
    if (body?.sent_count !== undefined) patch.sentCount = body.sent_count;
    if (body?.delivered_count !== undefined)
      patch.deliveredCount = body.delivered_count;
    if (body?.read_count !== undefined) patch.readCount = body.read_count;
    if (body?.replied_count !== undefined)
      patch.repliedCount = body.replied_count;
    if (body?.failed_count !== undefined) patch.failedCount = body.failed_count;

    const [broadcast] = await db
      .update(broadcasts)
      .set(patch)
      .where(
        and(eq(broadcasts.id, id), eq(broadcasts.accountId, ctx.accountId))
      )
      .returning(broadcastSelect);

    if (!broadcast) {
      return NextResponse.json(
        { error: 'Broadcast not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ broadcast });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    const [broadcast] = await db
      .select({ id: broadcasts.id, status: broadcasts.status })
      .from(broadcasts)
      .where(
        and(eq(broadcasts.id, id), eq(broadcasts.accountId, ctx.accountId))
      )
      .limit(1);

    if (!broadcast) {
      return NextResponse.json(
        { error: 'Broadcast not found' },
        { status: 404 }
      );
    }
    if (broadcast.status === 'sending') {
      return NextResponse.json(
        { error: 'Cannot delete while a broadcast is actively sending' },
        { status: 409 }
      );
    }

    await db.delete(broadcasts).where(eq(broadcasts.id, id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
