import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
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

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const fields = await db
      .select(fieldSelect)
      .from(customFields)
      .where(eq(customFields.accountId, ctx.accountId))
      .orderBy(asc(customFields.fieldName));
    return NextResponse.json({ fields });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => null)) as {
      field_name?: string;
      field_type?: string;
    } | null;
    const name = body?.field_name?.trim();
    if (!name)
      return NextResponse.json(
        { error: 'Field name is required' },
        { status: 400 }
      );
    const [field] = await db
      .insert(customFields)
      .values({
        userId: ctx.userId,
        accountId: ctx.accountId,
        fieldName: name,
        fieldType: body?.field_type || 'text',
      })
      .returning(fieldSelect);
    return NextResponse.json({ field }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
