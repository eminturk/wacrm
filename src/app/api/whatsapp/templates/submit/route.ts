/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server'
import { db, sql } from '@/lib/db'
import { getSession } from '@/lib/auth/session'
import { decrypt } from '@/lib/whatsapp/encryption'
import { submitMessageTemplate } from '@/lib/whatsapp/meta-api'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'

type DbRow = Record<string, any>

/**
 * Shared upsert payload builder — both the Meta-failure path and the
 * Meta-success path write nearly identical rows; dropping the shared
 * fields here means adding a column later only touches one spot.
 */
function buildUpsertRow(
  accountId: string,
  userId: string,
  payload: TemplatePayload,
  extras: {
    status: 'DRAFT' | string
    metaTemplateId: string | null
    submissionError: string | null
  },
) {
  return {
    // Account tenancy — required NOT NULL on message_templates as
    // of migration 017. Without this an INSERT throws on the
    // not-null constraint.
    account_id: accountId,
    // Original author — kept as audit only. The unique index is
    // still on (user_id, name, language) — see the upsert helper
    // for the cross-teammate dedup follow-up.
    user_id: userId,
    name: payload.name,
    category: payload.category,
    language: payload.language,
    header_type: payload.header_type ?? null,
    header_content: payload.header_content ?? null,
    header_media_url: payload.header_media_url ?? null,
    header_handle: payload.header_handle ?? null,
    body_text: payload.body_text,
    footer_text: payload.footer_text ?? null,
    buttons: payload.buttons ? JSON.stringify(payload.buttons) : null,
    sample_values: payload.sample_values ? JSON.stringify(payload.sample_values) : null,
    status: extras.status,
    meta_template_id: extras.metaTemplateId,
    submission_error: extras.submissionError,
    // Clear stale rejection_reason whenever we re-submit; the
    // webhook will set it again if Meta still rejects.
    rejection_reason: null,
  }
}

async function upsertTemplateRow(
  row: ReturnType<typeof buildUpsertRow>,
): Promise<DbRow> {
  const rows = (await db.execute(sql`
    INSERT INTO message_templates (
      account_id,
      user_id,
      name,
      category,
      language,
      header_type,
      header_content,
      header_media_url,
      header_handle,
      body_text,
      footer_text,
      buttons,
      sample_values,
      status,
      meta_template_id,
      submission_error,
      rejection_reason,
      last_submitted_at,
      updated_at
    ) VALUES (
      ${row.account_id},
      ${row.user_id},
      ${row.name},
      ${row.category},
      ${row.language},
      ${row.header_type},
      ${row.header_content},
      ${row.header_media_url},
      ${row.header_handle},
      ${row.body_text},
      ${row.footer_text},
      ${row.buttons}::jsonb,
      ${row.sample_values}::jsonb,
      ${row.status},
      ${row.meta_template_id},
      ${row.submission_error},
      ${row.rejection_reason},
      NOW(),
      NOW()
    )
    ON CONFLICT (user_id, name, language)
    DO UPDATE SET
      account_id = EXCLUDED.account_id,
      category = EXCLUDED.category,
      header_type = EXCLUDED.header_type,
      header_content = EXCLUDED.header_content,
      header_media_url = EXCLUDED.header_media_url,
      header_handle = EXCLUDED.header_handle,
      body_text = EXCLUDED.body_text,
      footer_text = EXCLUDED.footer_text,
      buttons = EXCLUDED.buttons,
      sample_values = EXCLUDED.sample_values,
      status = EXCLUDED.status,
      meta_template_id = EXCLUDED.meta_template_id,
      submission_error = EXCLUDED.submission_error,
      rejection_reason = EXCLUDED.rejection_reason,
      last_submitted_at = EXCLUDED.last_submitted_at,
      updated_at = NOW()
    RETURNING *
  `)) as DbRow[]
  return rows[0]
}

async function resolveAccountId(userId: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT account_id
    FROM profiles
    WHERE user_id = ${userId}
    LIMIT 1
  `)) as DbRow[]
  return rows[0]?.account_id ?? null
}

/**
 * Submit a template to Meta for approval AND persist it locally.
 *
 * Auth → fetch whatsapp_config → validate → (DRY_RUN short-circuit) →
 * POST to Meta → upsert local row by (user_id, name, language) with
 * status, meta_template_id, sample_values, last_submitted_at.
 *
 * When WHATSAPP_TEMPLATES_DRY_RUN=true, we skip the network call and
 * insert a row with a synthetic `dry-run-<uuid>` meta_template_id so
 * CI / local dev can exercise the full UI without a real Meta App.
 *
 * On the Meta side this is a one-way trip — a row can only be
 * submitted; editing or deleting requires hsm_id and lives in PR 4.
 */
export async function POST(request: Request) {
  try {
    const user = await getSession()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Resolve the caller's account_id — whatsapp_config + the
    // message_templates row are account-scoped post-multi-user.
    const accountId = await resolveAccountId(user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    let payload: TemplatePayload
    try {
      payload = (await request.json()) as TemplatePayload
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }

    if (payload.category === 'Authentication') {
      return NextResponse.json(
        {
          error:
            'AUTHENTICATION templates are not yet supported here — create them in Meta WhatsApp Manager and use "Sync from Meta".',
        },
        { status: 400 },
      )
    }

    try {
      validateTemplatePayload(payload)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Validation failed.' },
        { status: 400 },
      )
    }

    const dryRun =
      process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
      process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'

    let metaTemplateId: string
    let metaStatus: string

    if (dryRun) {
      metaTemplateId = `dry-run-${crypto.randomUUID()}`
      metaStatus = 'PENDING'
    } else {
      const configRows = (await db.execute(sql`
        SELECT *
        FROM whatsapp_config
        WHERE account_id = ${accountId}
        LIMIT 1
      `)) as DbRow[]
      const config = configRows[0]
      if (!config) {
        return NextResponse.json(
          {
            error:
              'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
          },
          { status: 400 },
        )
      }
      if (!config.waba_id) {
        return NextResponse.json(
          {
            error:
              'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.',
          },
          { status: 400 },
        )
      }

      const accessToken = decrypt(config.access_token)

      // Image headers need a Resumable-Upload handle (Meta rejects a
      // plain URL at creation). Derive it from header_media_url before
      // building the payload. Surfaces a 400 with an actionable message
      // (missing META_APP_ID, unreachable URL, wrong type/size).
      try {
        await ensureImageHeaderHandle(payload, accessToken)
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : 'Header image upload failed.' },
          { status: 400 },
        )
      }

      const metaPayload = buildMetaTemplatePayload(payload)
      try {
        const meta = await submitMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          payload: metaPayload,
        })
        metaTemplateId = meta.id
        metaStatus = meta.status
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta submit failed.'
        // Persist the failure so the user can retry; row stays DRAFT
        // until they fix and re-submit.
        await upsertTemplateRow(
          buildUpsertRow(accountId, user.id, payload, {
            status: 'DRAFT',
            metaTemplateId: null,
            submissionError: message,
          }),
        )
        const isRateLimit = /\b429\b/.test(message)
        return NextResponse.json(
          {
            error: isRateLimit
              ? 'Meta rate limit hit (100 template creates per hour). Try again later.'
              : message,
          },
          { status: isRateLimit ? 429 : 502 },
        )
      }
    }

    let row: DbRow
    try {
      row = await upsertTemplateRow(
        buildUpsertRow(accountId, user.id, payload, {
          status: normalizeStatus(metaStatus),
          metaTemplateId,
          submissionError: null,
        }),
      )
    } catch (upsertErr) {
      // The submit succeeded on Meta's side but we failed to persist
      // locally. That's a data-drift state — surface the meta_template_id
      // so the user can recover via "Sync from Meta".
      const message = upsertErr instanceof Error ? upsertErr.message : String(upsertErr)
      return NextResponse.json(
        {
          error: `Submitted to Meta but failed to save locally: ${message}. Run "Sync from Meta" to recover.`,
          meta_template_id: metaTemplateId,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      template: row,
      dry_run: dryRun,
    })
  } catch (error) {
    console.error('Error submitting template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to submit template.',
      },
      { status: 500 },
    )
  }
}
