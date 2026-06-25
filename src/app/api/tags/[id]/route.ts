import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tags } from '@/lib/db/schema';

export const runtime = 'nodejs';

const tagSelect = {
  id: tags.id,
  user_id: tags.userId,
  account_id: tags.accountId,
  name: tags.name,
  color: tags.color,
  created_at: tags.createdAt,
};

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      name?: string;
      color?: string;
    } | null;
    const update: { name?: string; color?: string } = {};
    if (body?.name?.trim()) update.name = body.name.trim();
    if (body?.color) update.color = body.color;
    const [tag] = await db
      .update(tags)
      .set(update)
      .where(and(eq(tags.id, id), eq(tags.accountId, ctx.accountId)))
      .returning(tagSelect);
    if (!tag)
      return NextResponse.json({ error: 'Tag not found' }, { status: 404 });
    return NextResponse.json({ tag });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    await db
      .delete(tags)
      .where(and(eq(tags.id, id), eq(tags.accountId, ctx.accountId)));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
