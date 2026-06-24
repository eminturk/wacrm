import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canEditSettings } from '@/lib/auth/roles';
import { contactTags, contacts, tags } from '@/lib/db/schema';
import { dedupeByPhone, normalizeKey } from '@/lib/contacts/dedupe';

export const runtime = 'nodejs';

const DEFAULT_TAG_COLOR = '#3b82f6';

type ImportRow = {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  tagNames: string[];
};

type TagAssignment = { contactId: string; tagNames: string[] };

async function resolveImportTagIds(params: {
  accountId: string;
  userId: string;
  tagNames: string[];
  canCreateTags: boolean;
}) {
  const uniqueNames: string[] = [];
  const seen = new Set<string>();
  for (const raw of params.tagNames) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueNames.push(name);
  }

  if (uniqueNames.length === 0)
    return { tagIdByKey: new Map<string, string>(), skippedNames: [] };

  const existing = await db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(eq(tags.accountId, params.accountId));

  const tagIdByKey = new Map<string, string>();
  for (const tag of existing) {
    const key = tag.name.trim().toLowerCase();
    if (!tagIdByKey.has(key)) tagIdByKey.set(key, tag.id);
  }

  const skippedNames: string[] = [];
  const toCreate: string[] = [];
  for (const name of uniqueNames) {
    const key = name.toLowerCase();
    if (tagIdByKey.has(key)) continue;
    if (params.canCreateTags) toCreate.push(name);
    else skippedNames.push(name);
  }

  if (toCreate.length > 0) {
    const created = await db
      .insert(tags)
      .values(
        toCreate.map((name) => ({
          userId: params.userId,
          accountId: params.accountId,
          name,
          color: DEFAULT_TAG_COLOR,
        }))
      )
      .returning({ id: tags.id, name: tags.name });
    for (const tag of created)
      tagIdByKey.set(tag.name.trim().toLowerCase(), tag.id);
  }

  return { tagIdByKey, skippedNames };
}

async function assignImportedContactTags(
  assignments: TagAssignment[],
  tagIdByKey: Map<string, string>
) {
  const rows: { contactId: string; tagId: string }[] = [];
  for (const { contactId, tagNames } of assignments) {
    const assignedTagIds = new Set<string>();
    for (const name of tagNames) {
      const tagId = tagIdByKey.get(name.trim().toLowerCase());
      if (!tagId || assignedTagIds.has(tagId)) continue;
      assignedTagIds.add(tagId);
      rows.push({ contactId, tagId });
    }
  }

  if (rows.length === 0) return 0;
  const chunkSize = 100;
  let assigned = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await db.insert(contactTags).values(chunk).onConflictDoNothing();
    assigned += chunk.length;
  }
  return assigned;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as {
      rows?: ImportRow[];
    } | null;
    const parsedRows = body?.rows ?? [];

    let imported = 0;
    let skipped = 0;
    let failed = 0;

    const { unique, duplicates } = dedupeByPhone(parsedRows);
    skipped += duplicates;

    const existingRows = await db
      .select({ phone_normalized: contacts.phoneNormalized })
      .from(contacts)
      .where(eq(contacts.accountId, ctx.accountId));
    const existing = new Set(
      existingRows
        .map((row) => row.phone_normalized)
        .filter((phone): phone is string => !!phone)
    );

    const toInsert = unique.filter((row) => {
      if (existing.has(normalizeKey(row.phone))) {
        skipped++;
        return false;
      }
      return true;
    });

    const allTagNames = toInsert.flatMap((row) => row.tagNames ?? []);
    let tagIdByKey = new Map<string, string>();
    let skippedNames: string[] = [];
    if (allTagNames.length > 0) {
      ({ tagIdByKey, skippedNames } = await resolveImportTagIds({
        accountId: ctx.accountId,
        userId: ctx.userId,
        tagNames: allTagNames,
        canCreateTags: canEditSettings(ctx.role),
      }));
    }

    const tagAssignments: TagAssignment[] = [];
    const chunkSize = 50;

    for (let i = 0; i < toInsert.length; i += chunkSize) {
      const chunk = toInsert.slice(i, i + chunkSize);
      const rows = chunk.map((row) => ({
        userId: ctx.userId,
        accountId: ctx.accountId,
        phone: row.phone,
        name: row.name || null,
        email: row.email || null,
        company: row.company || null,
      }));

      try {
        const inserted = await db
          .insert(contacts)
          .values(rows)
          .returning({ id: contacts.id });
        imported += inserted.length;
        for (let j = 0; j < inserted.length; j++) {
          const source = chunk[j];
          if (!source || source.tagNames.length === 0) continue;
          tagAssignments.push({
            contactId: inserted[j].id,
            tagNames: source.tagNames,
          });
        }
      } catch {
        for (let j = 0; j < rows.length; j++) {
          try {
            const [single] = await db
              .insert(contacts)
              .values(rows[j])
              .returning({ id: contacts.id });
            if (single) {
              imported++;
              const source = chunk[j];
              if (source?.tagNames.length) {
                tagAssignments.push({
                  contactId: single.id,
                  tagNames: source.tagNames,
                });
              }
            }
          } catch (err) {
            if (
              err &&
              typeof err === 'object' &&
              (err as { code?: string }).code === '23505'
            )
              skipped++;
            else failed++;
          }
        }
      }
    }

    let tagsAssigned = 0;
    try {
      tagsAssigned = await assignImportedContactTags(
        tagAssignments,
        tagIdByKey
      );
    } catch {
      // Keep the successful contact import result; client shows a warning.
    }

    return NextResponse.json({
      imported,
      skipped,
      failed,
      tagsAssigned,
      skippedNames,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
