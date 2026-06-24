import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { contactNotes, contacts } from '@/lib/db/schema';

export const runtime = 'nodejs';

const noteSelect = {
  id: contactNotes.id,
  contact_id: contactNotes.contactId,
  user_id: contactNotes.userId,
  account_id: contactNotes.accountId,
  note_text: contactNotes.noteText,
  created_at: contactNotes.createdAt,
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
    const notes = await db
      .select(noteSelect)
      .from(contactNotes)
      .where(
        and(
          eq(contactNotes.contactId, id),
          eq(contactNotes.accountId, ctx.accountId)
        )
      )
      .orderBy(desc(contactNotes.createdAt));
    return NextResponse.json({ notes });
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
      note_text?: string;
    } | null;
    const noteText = body?.note_text?.trim();
    if (!noteText)
      return NextResponse.json(
        { error: 'Note text is required' },
        { status: 400 }
      );
    const [note] = await db
      .insert(contactNotes)
      .values({
        contactId: id,
        userId: ctx.userId,
        accountId: ctx.accountId,
        noteText,
      })
      .returning(noteSelect);
    return NextResponse.json({ note }, { status: 201 });
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
    const url = new URL(request.url);
    const noteId = url.searchParams.get('noteId');
    if (!noteId)
      return NextResponse.json(
        { error: 'noteId is required' },
        { status: 400 }
      );
    await db
      .delete(contactNotes)
      .where(
        and(
          eq(contactNotes.id, noteId),
          eq(contactNotes.contactId, id),
          eq(contactNotes.accountId, ctx.accountId)
        )
      );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
