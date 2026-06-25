import { NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';

import { db } from '@/lib/db';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { contactTags, contacts, tags } from '@/lib/db/schema';

export const runtime = 'nodejs';

const contactTagSelect = {
  id: contactTags.id,
  contact_id: contactTags.contactId,
  tag_id: contactTags.tagId,
  created_at: contactTags.createdAt,
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
    const rows = await db
      .select(contactTagSelect)
      .from(contactTags)
      .innerJoin(tags, eq(contactTags.tagId, tags.id))
      .where(
        and(eq(contactTags.contactId, id), eq(tags.accountId, ctx.accountId))
      );
    return NextResponse.json({ contact_tags: rows });
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
      tagIds?: string[];
    } | null;
    const tagIds = body?.tagIds?.filter(Boolean) ?? [];

    await db.transaction(async (tx) => {
      await tx.delete(contactTags).where(eq(contactTags.contactId, id));
      if (tagIds.length === 0) return;
      const scopedTags = await tx
        .select({ id: tags.id })
        .from(tags)
        .where(
          and(eq(tags.accountId, ctx.accountId), inArray(tags.id, tagIds))
        );
      if (scopedTags.length > 0) {
        await tx
          .insert(contactTags)
          .values(scopedTags.map((tag) => ({ contactId: id, tagId: tag.id })));
      }
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
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
      tagId?: string;
    } | null;
    if (!body?.tagId)
      return NextResponse.json({ error: 'tagId is required' }, { status: 400 });
    const [tag] = await db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.id, body.tagId), eq(tags.accountId, ctx.accountId)))
      .limit(1);
    if (!tag)
      return NextResponse.json({ error: 'Tag not found' }, { status: 404 });
    await db
      .insert(contactTags)
      .values({ contactId: id, tagId: tag.id })
      .onConflictDoNothing();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    if (!(await ensureContact(id, ctx.accountId))) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }
    const url = new URL(request.url);
    const tagId = url.searchParams.get('tagId');
    if (!tagId)
      return NextResponse.json({ error: 'tagId is required' }, { status: 400 });
    await db
      .delete(contactTags)
      .where(and(eq(contactTags.contactId, id), eq(contactTags.tagId, tagId)));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
