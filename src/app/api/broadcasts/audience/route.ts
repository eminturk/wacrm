import { NextResponse } from 'next/server';
import { and, asc, desc, eq, ilike, inArray, not } from 'drizzle-orm';

import { db } from '@/lib/db';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  contactCustomValues,
  contacts,
  contactTags,
  customFields,
} from '@/lib/db/schema';
import { normalizeKey } from '@/lib/contacts/dedupe';

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

const fieldSelect = {
  id: customFields.id,
  user_id: customFields.userId,
  account_id: customFields.accountId,
  field_name: customFields.fieldName,
  field_type: customFields.fieldType,
  field_options: customFields.fieldOptions,
  created_at: customFields.createdAt,
};

type AudienceConfig = {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: {
    fieldId: string;
    operator: 'is' | 'is_not' | 'contains';
    value: string;
  };
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
};

type Body = {
  action?: 'count' | 'resolve' | 'preview' | 'custom-values';
  audience?: AudienceConfig;
  contactIds?: string[];
};

async function contactIdsForTags(accountId: string, tagIds: string[]) {
  if (tagIds.length === 0) return [];
  const rows = await db
    .select({ contact_id: contactTags.contactId })
    .from(contactTags)
    .innerJoin(contacts, eq(contactTags.contactId, contacts.id))
    .where(
      and(eq(contacts.accountId, accountId), inArray(contactTags.tagId, tagIds))
    );
  return [...new Set(rows.map((row) => row.contact_id))];
}

async function contactIdsForCustomField(
  accountId: string,
  filter: NonNullable<AudienceConfig['customField']>
) {
  const conditions = [
    eq(contacts.accountId, accountId),
    eq(contactCustomValues.customFieldId, filter.fieldId),
  ];
  if (filter.operator === 'is')
    conditions.push(eq(contactCustomValues.value, filter.value));
  else if (filter.operator === 'is_not')
    conditions.push(not(eq(contactCustomValues.value, filter.value))!);
  else conditions.push(ilike(contactCustomValues.value, `%${filter.value}%`));

  const rows = await db
    .select({ contact_id: contactCustomValues.contactId })
    .from(contactCustomValues)
    .innerJoin(contacts, eq(contactCustomValues.contactId, contacts.id))
    .where(and(...conditions));
  return [...new Set(rows.map((row) => row.contact_id))];
}

async function applyExcludes(
  accountId: string,
  contactIds: string[],
  excludeTagIds?: string[]
) {
  if (!excludeTagIds || excludeTagIds.length === 0) return contactIds;
  const excluded = new Set(await contactIdsForTags(accountId, excludeTagIds));
  return contactIds.filter((id) => !excluded.has(id));
}

async function upsertCsvContacts(
  accountId: string,
  userId: string,
  csvRows: { phone: string; name?: string }[]
) {
  const uniqueByPhone = new Map<string, { phone: string; name?: string }>();
  for (const row of csvRows) {
    const key = normalizeKey(row.phone);
    if (key) uniqueByPhone.set(key, row);
  }
  const normalizedPhones = [...uniqueByPhone.keys()];
  if (normalizedPhones.length === 0) return [];

  const existing = await db
    .select(contactSelect)
    .from(contacts)
    .where(
      and(
        eq(contacts.accountId, accountId),
        inArray(contacts.phoneNormalized, normalizedPhones)
      )
    );
  const byNormalized = new Map(
    existing.map((contact) => [
      contact.phone_normalized || normalizeKey(contact.phone),
      contact,
    ])
  );

  const missing = normalizedPhones
    .filter((phone) => !byNormalized.has(phone))
    .map((normalized) => {
      const row = uniqueByPhone.get(normalized)!;
      return {
        userId,
        accountId,
        phone: row.phone,
        name: row.name ?? null,
      };
    });

  const INSERT_CHUNK = 200;
  for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
    const inserted = await db
      .insert(contacts)
      .values(missing.slice(i, i + INSERT_CHUNK))
      .returning(contactSelect);
    for (const contact of inserted) {
      byNormalized.set(
        contact.phone_normalized || normalizeKey(contact.phone),
        contact
      );
    }
  }

  return normalizedPhones
    .map((phone) => byNormalized.get(phone))
    .filter((contact): contact is NonNullable<typeof contact> =>
      Boolean(contact)
    );
}

async function resolveAudience(
  accountId: string,
  userId: string,
  audience: AudienceConfig,
  canCreateCsv: boolean
) {
  if (audience.type === 'csv') {
    if (!canCreateCsv)
      throw new Error('CSV audience resolution requires agent role.');
    return upsertCsvContacts(accountId, userId, audience.csvContacts ?? []);
  }

  let ids: string[] | null = null;
  if (audience.type === 'tags') {
    ids = audience.tagIds?.length
      ? await contactIdsForTags(accountId, audience.tagIds)
      : [];
  } else if (
    audience.type === 'custom_field' &&
    audience.customField?.fieldId &&
    audience.customField.value
  ) {
    ids = await contactIdsForCustomField(accountId, audience.customField);
  }

  if (ids !== null)
    ids = await applyExcludes(accountId, ids, audience.excludeTagIds);

  if (ids !== null) {
    if (ids.length === 0) return [];
    return db
      .select(contactSelect)
      .from(contacts)
      .where(and(eq(contacts.accountId, accountId), inArray(contacts.id, ids)));
  }

  let rows = await db
    .select(contactSelect)
    .from(contacts)
    .where(eq(contacts.accountId, accountId))
    .orderBy(desc(contacts.createdAt));

  if (audience.excludeTagIds?.length) {
    const allowedIds = new Set(
      await applyExcludes(
        accountId,
        rows.map((row) => row.id),
        audience.excludeTagIds
      )
    );
    rows = rows.filter((row) => allowedIds.has(row.id));
  }
  return rows;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as Body | null;
    const action = body?.action ?? 'count';

    if (action === 'resolve') {
      const ctx = await requireRole('agent');
      const audience = body?.audience;
      if (!audience)
        return NextResponse.json(
          { error: 'Audience is required' },
          { status: 400 }
        );
      const resolved = await resolveAudience(
        ctx.accountId,
        ctx.userId,
        audience,
        true
      );
      return NextResponse.json({ contacts: resolved, count: resolved.length });
    }

    const ctx = await getCurrentAccount();

    if (action === 'preview') {
      const [fields, [contact]] = await Promise.all([
        db
          .select(fieldSelect)
          .from(customFields)
          .where(eq(customFields.accountId, ctx.accountId))
          .orderBy(asc(customFields.fieldName)),
        db
          .select(contactSelect)
          .from(contacts)
          .where(eq(contacts.accountId, ctx.accountId))
          .orderBy(desc(contacts.createdAt))
          .limit(1),
      ]);

      const values = contact
        ? await db
            .select({
              custom_field_id: contactCustomValues.customFieldId,
              value: contactCustomValues.value,
            })
            .from(contactCustomValues)
            .where(eq(contactCustomValues.contactId, contact.id))
        : [];

      return NextResponse.json({
        fields,
        contact: contact ?? null,
        customValues: values,
      });
    }

    if (action === 'custom-values') {
      const contactIds = body?.contactIds?.filter(Boolean) ?? [];
      if (contactIds.length === 0) return NextResponse.json({ values: [] });
      const rows = await db
        .select({
          contact_id: contactCustomValues.contactId,
          custom_field_id: contactCustomValues.customFieldId,
          value: contactCustomValues.value,
        })
        .from(contactCustomValues)
        .innerJoin(contacts, eq(contactCustomValues.contactId, contacts.id))
        .where(
          and(
            eq(contacts.accountId, ctx.accountId),
            inArray(contactCustomValues.contactId, contactIds)
          )
        );
      return NextResponse.json({ values: rows });
    }

    const audience = body?.audience;
    if (!audience)
      return NextResponse.json(
        { error: 'Audience is required' },
        { status: 400 }
      );
    if (audience.type === 'csv') {
      return NextResponse.json({ count: audience.csvContacts?.length ?? 0 });
    }
    const resolved = await resolveAudience(
      ctx.accountId,
      ctx.userId,
      audience,
      false
    );
    return NextResponse.json({ count: resolved.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
