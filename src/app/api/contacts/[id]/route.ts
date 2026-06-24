import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { contacts } from '@/lib/db/schema';

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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const [contact] = await db
      .select(contactSelect)
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)))
      .limit(1);
    if (!contact)
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    return NextResponse.json({ contact });
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
      name?: string | null;
      phone?: string;
      email?: string | null;
      company?: string | null;
    } | null;

    if (!body?.phone?.trim()) {
      return NextResponse.json(
        { error: 'Phone number is required' },
        { status: 400 }
      );
    }

    try {
      const [contact] = await db
        .update(contacts)
        .set({
          name: body.name?.trim() || null,
          phone: body.phone.trim(),
          email: body.email?.trim() || null,
          company: body.company?.trim() || null,
          updatedAt: new Date(),
        })
        .where(and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)))
        .returning(contactSelect);

      if (!contact)
        return NextResponse.json(
          { error: 'Contact not found' },
          { status: 404 }
        );
      return NextResponse.json({ contact });
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        (err as { code?: string }).code === '23505'
      ) {
        return NextResponse.json(
          {
            error: 'A contact with this phone number already exists',
            code: '23505',
          },
          { status: 409 }
        );
      }
      throw err;
    }
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
    await db
      .delete(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
