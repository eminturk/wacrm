import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { customFields } from '@/lib/db/schema';

export const runtime = 'nodejs';

const fieldSelect = {
  id: customFields.id,
  user_id: customFields.userId,
  account_id: customFields.accountId,
  field_name: customFields.fieldName,
  field_type: customFields.fieldType,
  field_options: customFields.fieldOptions,
  created_at: customFields.createdAt,
};

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      field_name?: string;
    } | null;
    const name = body?.field_name?.trim();
    if (!name)
      return NextResponse.json(
        { error: 'Field name is required' },
        { status: 400 }
      );
    const [field] = await db
      .update(customFields)
      .set({ fieldName: name })
      .where(
        and(eq(customFields.id, id), eq(customFields.accountId, ctx.accountId))
      )
      .returning(fieldSelect);
    if (!field)
      return NextResponse.json({ error: 'Field not found' }, { status: 404 });
    return NextResponse.json({ field });
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
      .delete(customFields)
      .where(
        and(eq(customFields.id, id), eq(customFields.accountId, ctx.accountId))
      );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
