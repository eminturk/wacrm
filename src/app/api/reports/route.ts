/**
 * GET /api/reports
 *
 * Returns broadcast-level delivery metrics filtered by date range,
 * status, template name, or broadcast name. Supports CSV export.
 *
 * Query params:
 *   from          — ISO date (createdAt >=)
 *   to            — ISO date (createdAt <=)
 *   status        — broadcast status (sent | sending | failed | draft | …)
 *   template_name — filter by template name
 *   broadcast_name — filter by broadcast name (substring)
 *   format        — "json" (default) | "csv"
 *   limit         — max rows (default 200, max 1000)
 *   offset        — pagination
 */

import { NextResponse } from 'next/server';
import { and, desc, eq, gte, ilike, lte } from 'drizzle-orm';

import { db } from '@/lib/db';
import { broadcasts, broadcastRecipients, contacts } from '@/lib/db/schema';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

export const runtime = 'nodejs';

function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowToCsv(row: Record<string, unknown>): string {
  return Object.values(row).map((v) => escapeCsvField(v as string | number | null | undefined)).join(',');
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const url = new URL(request.url);

    const format = url.searchParams.get('format') ?? 'json';
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '200', 10), 1000);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const from = url.searchParams.get('from') ?? undefined;
    const to = url.searchParams.get('to') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    const templateNameFilter = url.searchParams.get('template_name') ?? undefined;
    const broadcastNameFilter = url.searchParams.get('broadcast_name') ?? undefined;

    const conditions = [eq(broadcasts.accountId, ctx.accountId)];
    if (from) conditions.push(gte(broadcasts.createdAt, new Date(from)));
    if (to) conditions.push(lte(broadcasts.createdAt, new Date(to)));
    if (status) conditions.push(eq(broadcasts.status, status));
    if (templateNameFilter) conditions.push(eq(broadcasts.templateName, templateNameFilter));
    if (broadcastNameFilter) conditions.push(ilike(broadcasts.name, `%${broadcastNameFilter}%`));

    const rows = await db
      .select({
        id: broadcasts.id,
        name: broadcasts.name,
        template_name: broadcasts.templateName,
        template_language: broadcasts.templateLanguage,
        status: broadcasts.status,
        total_recipients: broadcasts.totalRecipients,
        sent_count: broadcasts.sentCount,
        delivered_count: broadcasts.deliveredCount,
        read_count: broadcasts.readCount,
        replied_count: broadcasts.repliedCount,
        failed_count: broadcasts.failedCount,
        created_at: broadcasts.createdAt,
        updated_at: broadcasts.updatedAt,
      })
      .from(broadcasts)
      .where(and(...conditions))
      .orderBy(desc(broadcasts.createdAt))
      .limit(limit)
      .offset(offset);

    if (format === 'csv') {
      const headers = [
        'id',
        'name',
        'template_name',
        'template_language',
        'status',
        'total_recipients',
        'sent_count',
        'delivered_count',
        'read_count',
        'replied_count',
        'failed_count',
        'created_at',
        'updated_at',
      ];
      const csvLines = [
        headers.join(','),
        ...rows.map((r) => rowToCsv(r as Record<string, unknown>)),
      ];
      return new Response(csvLines.join('\n'), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="broadcast-report-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    return NextResponse.json({ reports: rows, offset, limit });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * GET /api/reports/recipients — per-recipient detail for a broadcast.
 * Exported as a sub-resource by passing ?broadcast_id=.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const body = (await request.json().catch(() => null)) as {
      broadcast_id?: string;
      format?: string;
    } | null;

    if (!body?.broadcast_id) {
      return NextResponse.json({ error: 'broadcast_id is required' }, { status: 400 });
    }

    // Verify broadcast belongs to account
    const [broadcast] = await db
      .select({ id: broadcasts.id, name: broadcasts.name, templateName: broadcasts.templateName })
      .from(broadcasts)
      .where(and(eq(broadcasts.id, body.broadcast_id), eq(broadcasts.accountId, ctx.accountId)))
      .limit(1);

    if (!broadcast) {
      return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 });
    }

    const rows = await db
      .select({
        recipient_id: broadcastRecipients.id,
        contact_id: broadcastRecipients.contactId,
        contact_name: contacts.name,
        contact_phone: contacts.phone,
        status: broadcastRecipients.status,
        whatsapp_message_id: broadcastRecipients.whatsappMessageId,
        error_message: broadcastRecipients.errorMessage,
        error_code: broadcastRecipients.errorCode,
        sent_at: broadcastRecipients.sentAt,
        delivered_at: broadcastRecipients.deliveredAt,
        read_at: broadcastRecipients.readAt,
        replied_at: broadcastRecipients.repliedAt,
        created_at: broadcastRecipients.createdAt,
      })
      .from(broadcastRecipients)
      .leftJoin(contacts, eq(broadcastRecipients.contactId, contacts.id))
      .where(eq(broadcastRecipients.broadcastId, body.broadcast_id))
      .orderBy(desc(broadcastRecipients.createdAt));

    if (body.format === 'csv') {
      const headers = [
        'recipient_id',
        'contact_id',
        'contact_name',
        'contact_phone',
        'status',
        'whatsapp_message_id',
        'error_message',
        'error_code',
        'sent_at',
        'delivered_at',
        'read_at',
        'replied_at',
        'created_at',
      ];
      const csvLines = [
        headers.join(','),
        ...rows.map((r) => rowToCsv(r as Record<string, unknown>)),
      ];
      const filename = `broadcast-${body.broadcast_id.slice(0, 8)}-recipients-${new Date().toISOString().slice(0, 10)}.csv`;
      return new Response(csvLines.join('\n'), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    return NextResponse.json({
      broadcast_id: body.broadcast_id,
      broadcast_name: broadcast.name,
      template_name: broadcast.templateName,
      recipients: rows,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
