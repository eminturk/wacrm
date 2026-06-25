import { NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';

import { db } from '@/lib/db';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { contactCustomValues, contacts, customFields } from '@/lib/db/schema';

export const runtime = 'nodejs';

const valueSelect = {
  id: contactCustomValues.id,
  contact_id: contactCustomValues.contactId,
  custom_field_id: contactCustomValues.customFieldId,
  value: contactCustomValues.value,
  created_at: contactCustomValues.createdAt,
};

async function ensureContact(id: string, accountId: string) {
  const [contact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.accountId, accountId)))
    .limit(1);
  return contact;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    if (!(await ensureContact(id, ctx.accountId))) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }
    const values = await db
      .select(valueSelect)
      .from(contactCustomValues)
      .innerJoin(
        customFields,
        eq(contactCustomValues.customFieldId, customFields.id)
      )
      .where(
        and(
          eq(contactCustomValues.contactId, id),
          eq(customFields.accountId, ctx.accountId)
        )
      );
    return NextResponse.json({ values });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    if (!(await ensureContact(id, ctx.accountId))) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as {
      values?: Record<string, string>;
    } | null;
    const entries = Object.entries(body?.values ?? {}).filter(([, value]) =>
      value.trim()
    );

    await db.transaction(async (tx) => {
      await tx
        .delete(contactCustomValues)
        .where(eq(contactCustomValues.contactId, id));
      if (entries.length === 0) return;
      const fieldIds = entries.map(([fieldId]) => fieldId);
      const scopedFields = await tx
        .select({ id: customFields.id })
        .from(customFields)
        .where(
          and(
            eq(customFields.accountId, ctx.accountId),
            inArray(customFields.id, fieldIds)
          )
        );
      const scoped = new Set(scopedFields.map((field) => field.id));
      const rows = entries
        .filter(([fieldId]) => scoped.has(fieldId))
        .map(([fieldId, value]) => ({
          contactId: id,
          customFieldId: fieldId,
          value: value.trim(),
        }));
      if (rows.length > 0) await tx.insert(contactCustomValues).values(rows);
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
