import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { accounts } from '@/lib/db/schema';
import { requireRole, toErrorResponse, isIpAllowed } from '@/lib/auth/account';
import { writeAuditLog, getClientIp } from '@/lib/audit';

export const runtime = 'nodejs';

/** GET /api/account/ip-allowlist — return the current allowlist */
export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const [account] = await db
      .select({ ipAllowlist: accounts.ipAllowlist })
      .from(accounts)
      .where(eq(accounts.id, ctx.accountId))
      .limit(1);

    return NextResponse.json({ ip_allowlist: account?.ipAllowlist ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** PUT /api/account/ip-allowlist — replace the allowlist */
export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('owner');
    const ip = getClientIp(request);

    const body = (await request.json().catch(() => null)) as {
      ip_allowlist?: unknown;
    } | null;

    if (!body || !Array.isArray(body.ip_allowlist)) {
      return NextResponse.json(
        { error: 'ip_allowlist must be an array of strings' },
        { status: 400 },
      );
    }

    const newList = (body.ip_allowlist as unknown[])
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim());

    // Safety: ensure the caller's own IP is not locked out. If the new
    // list is non-empty and the caller's IP is not in it, reject.
    if (newList.length > 0 && ip && !isIpAllowed(ip, newList)) {
      return NextResponse.json(
        {
          error:
            'Your current IP address is not in the new allowlist. ' +
            'Add your IP first to avoid locking yourself out.',
          your_ip: ip,
        },
        { status: 422 },
      );
    }

    await db
      .update(accounts)
      .set({ ipAllowlist: newList, updatedAt: new Date() })
      .where(eq(accounts.id, ctx.accountId));

    void writeAuditLog({
      accountId: ctx.accountId,
      userId: ctx.userId,
      action: 'ip_allowlist.update',
      resourceType: 'account',
      resourceId: ctx.accountId,
      metadata: { ip_allowlist: newList },
      ipAddress: ip,
    });

    return NextResponse.json({ ip_allowlist: newList });
  } catch (err) {
    return toErrorResponse(err);
  }
}
