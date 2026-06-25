import { NextResponse } from 'next/server';
import { and, desc, eq, gte, lte } from 'drizzle-orm';

import { db } from '@/lib/db';
import { auditLogs } from '@/lib/db/schema';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

export const runtime = 'nodejs';

/**
 * GET /api/audit-logs
 *
 * Query params:
 *   limit   — max rows (default 100, max 500)
 *   offset  — pagination
 *   action  — filter by action prefix (e.g. "login")
 *   from    — ISO date lower bound (created_at >=)
 *   to      — ISO date upper bound (created_at <=)
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const url = new URL(request.url);

    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10), 500);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const action = url.searchParams.get('action') ?? undefined;
    const from = url.searchParams.get('from') ?? undefined;
    const to = url.searchParams.get('to') ?? undefined;

    const conditions = [eq(auditLogs.accountId, ctx.accountId)];
    if (from) conditions.push(gte(auditLogs.createdAt, new Date(from)));
    if (to) conditions.push(lte(auditLogs.createdAt, new Date(to)));

    let query = db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        resource_type: auditLogs.resourceType,
        resource_id: auditLogs.resourceId,
        user_id: auditLogs.userId,
        metadata: auditLogs.metadata,
        ip_address: auditLogs.ipAddress,
        user_agent: auditLogs.userAgent,
        created_at: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset);

    // action filter is applied after the typed query construction
    // (Drizzle doesn't have a LIKE helper exported at the top level in
    // all versions; use the result-filter approach for simplicity).
    const rows = await query;
    const filtered = action
      ? rows.filter((r) => r.action.startsWith(action))
      : rows;

    return NextResponse.json({ audit_logs: filtered, offset, limit });
  } catch (err) {
    return toErrorResponse(err);
  }
}
