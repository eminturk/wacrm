import { NextResponse } from 'next/server'
import { and, asc, count, eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { accounts, customFields, messageTemplates, profiles, tags, users, whatsappConfig } from '@/lib/db/schema'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const [row] = await db
      .select({
        id: profiles.id,
        user_id: profiles.userId,
        full_name: profiles.fullName,
        email: profiles.email,
        avatar_url: profiles.avatarUrl,
        role: profiles.role,
        beta_features: profiles.betaFeatures,
        account_id: profiles.accountId,
        account_role: profiles.accountRole,
        created_at: profiles.createdAt,
        updated_at: profiles.updatedAt,
        user_created_at: users.createdAt,
        account_default_currency: accounts.defaultCurrency,
      })
      .from(profiles)
      .innerJoin(users, eq(profiles.userId, users.id))
      .innerJoin(accounts, eq(profiles.accountId, accounts.id))
      .where(eq(profiles.userId, ctx.userId))
      .limit(1)
    return NextResponse.json({ profile: row ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = await request.json().catch(() => ({}))

    if ('default_currency' in body) {
      await requireRole('admin')
      const value = String(body.default_currency ?? '').trim() || 'USD'
      await db
        .update(accounts)
        .set({ defaultCurrency: value, updatedAt: new Date() })
        .where(eq(accounts.id, ctx.accountId))
      return NextResponse.json({ ok: true })
    }

    const update: Partial<typeof profiles.$inferInsert> = { updatedAt: new Date() }
    if ('full_name' in body) update.fullName = String(body.full_name ?? '').trim()
    if ('avatar_url' in body) update.avatarUrl = body.avatar_url ?? null
    if ('email' in body) {
      const email = String(body.email ?? '').trim().toLowerCase()
      update.email = email
      await db.update(users).set({ email }).where(eq(users.id, ctx.userId))
    }

    await db.update(profiles).set(update).where(eq(profiles.userId, ctx.userId))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST() {
  try {
    const ctx = await getCurrentAccount()
    const [templatesTotal, templatesPending, tagsTotal, customFieldsTotal, whatsapp, customFieldRows] = await Promise.all([
      db.select({ c: count() }).from(messageTemplates).where(eq(messageTemplates.accountId, ctx.accountId)),
      db
        .select({ c: count() })
        .from(messageTemplates)
        .where(and(eq(messageTemplates.accountId, ctx.accountId), eq(messageTemplates.status, 'PENDING'))),
      db.select({ c: count() }).from(tags).where(eq(tags.accountId, ctx.accountId)),
      db.select({ c: count() }).from(customFields).where(eq(customFields.accountId, ctx.accountId)),
      db
        .select({ phone_number_id: whatsappConfig.phoneNumberId })
        .from(whatsappConfig)
        .where(eq(whatsappConfig.accountId, ctx.accountId))
        .limit(1),
      db
        .select({
          id: customFields.id,
          user_id: customFields.userId,
          account_id: customFields.accountId,
          field_name: customFields.fieldName,
          field_type: customFields.fieldType,
          field_options: customFields.fieldOptions,
          created_at: customFields.createdAt,
        })
        .from(customFields)
        .where(eq(customFields.accountId, ctx.accountId))
        .orderBy(asc(customFields.fieldName)),
    ])
    return NextResponse.json({
      counts: {
        templates: templatesTotal[0]?.c ?? 0,
        templatesPending: templatesPending[0]?.c ?? 0,
        tags: tagsTotal[0]?.c ?? 0,
        customFields: customFieldsTotal[0]?.c ?? 0,
      },
      whatsapp: { configured: !!whatsapp[0]?.phone_number_id },
      customFields: customFieldRows,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
