import { NextResponse } from 'next/server';
import { and, count, desc, eq, ilike, inArray, or } from 'drizzle-orm';

import { db, sql } from '@/lib/db';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { contacts, contactTags, tags } from '@/lib/db/schema';
import { normalizeKey } from '@/lib/contacts/dedupe';
import { phonesMatch } from '@/lib/whatsapp/phone-utils';

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

const tagSelect = {
  id: tags.id,
  user_id: tags.userId,
  account_id: tags.accountId,
  name: tags.name,
  color: tags.color,
  created_at: tags.createdAt,
};

async function findExistingContact(accountId: string, phone: string) {
  const normalized = normalizeKey(phone);
  if (!normalized) return null;
  const suffix = normalized.length >= 8 ? normalized.slice(-8) : normalized;
  const rows = await db
    .select(contactSelect)
    .from(contacts)
    .where(
      and(
        eq(contacts.accountId, accountId),
        or(
          ilike(contacts.phone, `%${suffix}`),
          eq(contacts.phoneNormalized, normalized)
        )
      )
    );
  return rows.find((contact) => phonesMatch(contact.phone, phone)) ?? null;
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const url = new URL(request.url);
    const duplicatePhone = url.searchParams.get('duplicatePhone')?.trim();
    if (duplicatePhone) {
      const contact = await findExistingContact(ctx.accountId, duplicatePhone);
      return NextResponse.json({ contact });
    }

    const limit = Math.min(
      Math.max(Number(url.searchParams.get('limit') ?? '25'), 1),
      100
    );
    const offset = Math.max(Number(url.searchParams.get('offset') ?? '0'), 0);
    const search = url.searchParams.get('search')?.trim() || null;
    const tagIds = url.searchParams.getAll('tagId').filter(Boolean);

    let rows: (typeof contactSelect extends Record<string, unknown>
      ? Record<string, unknown>
      : never)[];
    let total = 0;

    if (tagIds.length > 0) {
      const accountTags = await db
        .select({ id: tags.id })
        .from(tags)
        .where(
          and(eq(tags.accountId, ctx.accountId), inArray(tags.id, tagIds))
        );
      const scopedTagIds = accountTags.map((tag) => tag.id);
      if (scopedTagIds.length === 0) {
        return NextResponse.json({ contacts: [], count: 0 });
      }

      const rpcRows = (await db.execute(sql`
        SELECT * FROM filter_contacts_by_tags(
          ${scopedTagIds}::uuid[],
          ${search},
          ${limit},
          ${offset}
        )
        WHERE (contact).account_id = ${ctx.accountId}
      `)) as {
        contact: Record<string, unknown>;
        total_count: number | string;
      }[];

      rows = rpcRows.map((row) => row.contact);
      total = rpcRows.length > 0 ? Number(rpcRows[0].total_count) : 0;
    } else {
      const conditions = [eq(contacts.accountId, ctx.accountId)];
      if (search) {
        const pattern = `%${search}%`;
        conditions.push(
          or(
            ilike(contacts.name, pattern),
            ilike(contacts.phone, pattern),
            ilike(contacts.email, pattern)
          )!
        );
      }
      const where = and(...conditions);
      rows = await db
        .select(contactSelect)
        .from(contacts)
        .where(where)
        .orderBy(desc(contacts.createdAt))
        .limit(limit)
        .offset(offset);
      const [{ c }] = await db
        .select({ c: count() })
        .from(contacts)
        .where(where);
      total = Number(c);
    }

    if (rows.length === 0)
      return NextResponse.json({ contacts: [], count: total });

    const contactIds = rows.map((contact) => String(contact.id));
    const tagRows = await db
      .select({ contact_id: contactTags.contactId, tag: tagSelect })
      .from(contactTags)
      .innerJoin(tags, eq(contactTags.tagId, tags.id))
      .where(
        and(
          eq(tags.accountId, ctx.accountId),
          inArray(contactTags.contactId, contactIds)
        )
      );

    const tagsByContact = new Map<
      string,
      (typeof tagSelect extends Record<string, unknown>
        ? Record<string, unknown>
        : never)[]
    >();
    for (const row of tagRows) {
      const list = tagsByContact.get(row.contact_id) ?? [];
      list.push(row.tag);
      tagsByContact.set(row.contact_id, list);
    }

    return NextResponse.json({
      contacts: rows.map((contact) => ({
        ...contact,
        tags: tagsByContact.get(String(contact.id)) ?? [],
      })),
      count: total,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as {
      name?: string | null;
      phone?: string;
      email?: string | null;
      company?: string | null;
      tagIds?: string[];
    } | null;

    if (!body?.phone?.trim()) {
      return NextResponse.json(
        { error: 'Phone number is required' },
        { status: 400 }
      );
    }

    try {
      const contact = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(contacts)
          .values({
            userId: ctx.userId,
            accountId: ctx.accountId,
            name: body.name?.trim() || null,
            phone: body.phone!.trim(),
            email: body.email?.trim() || null,
            company: body.company?.trim() || null,
          })
          .returning(contactSelect);

        const tagIds = Array.isArray(body.tagIds)
          ? body.tagIds.filter(Boolean)
          : [];
        if (created && tagIds.length > 0) {
          const scopedTags = await tx
            .select({ id: tags.id })
            .from(tags)
            .where(
              and(eq(tags.accountId, ctx.accountId), inArray(tags.id, tagIds))
            );
          if (scopedTags.length > 0) {
            await tx.insert(contactTags).values(
              scopedTags.map((tag) => ({
                contactId: created.id,
                tagId: tag.id,
              }))
            );
          }
        }
        return created;
      });

      return NextResponse.json({ contact }, { status: 201 });
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        (err as { code?: string }).code === '23505'
      ) {
        const existing = await findExistingContact(ctx.accountId, body.phone);
        return NextResponse.json(
          {
            error: 'A contact with this phone number already exists',
            code: '23505',
            contact: existing,
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

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as {
      ids?: string[];
    } | null;
    const ids = body?.ids?.filter(Boolean) ?? [];
    if (ids.length === 0) return NextResponse.json({ ok: true });

    await db
      .delete(contacts)
      .where(
        and(eq(contacts.accountId, ctx.accountId), inArray(contacts.id, ids))
      );

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
