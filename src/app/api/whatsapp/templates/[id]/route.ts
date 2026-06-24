/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server'
import { db, sql } from '@/lib/db'
import { getSession } from '@/lib/auth/session'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  deleteMessageTemplate,
  editMessageTemplate,
} from '@/lib/whatsapp/meta-api'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle'

type DbRow = Record<string, any>

/**
 * Per-template lifecycle endpoint.
 *
 * PATCH  — edit an existing Meta-side template (and re-submit). Used
 *          by the "Edit" action on APPROVED rows and the "Resubmit"
 *          action on REJECTED / PAUSED rows. Meta replaces components
 *          wholesale on edit and bumps status back to PENDING.
 *
 * DELETE — remove the template on Meta (when meta_template_id is set,
 *          scoped to a single language variant via hsm_id) AND drop
 *          the local row. Local-only rows skip the Meta call.
 *
 * Initial submission (DRAFT → PENDING) lives at the sibling
 * /submit endpoint — keep this route narrowly about lifecycle of
 * already-submitted templates.
 */

const EDITABLE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED'])

// uuid v4 plus the looser shape Postgres gen_random_uuid emits.
// We don't need exhaustive RFC parsing — just enough to reject
// "../etc/passwd"-style payloads before they hit the database.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isDryRun(): boolean {
  return (
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  )
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

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: 'Invalid template id.' },
        { status: 400 },
      )
    }
    const user = await getSession()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Resolve the caller's account_id so template + whatsapp_config
    // lookups work for teammates who didn't author the row.
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

    // Account scoping handles ownership, but we need the existing row to read
    // meta_template_id and status — fetch explicitly.
    const existingRows = (await db.execute(sql`
      SELECT id, name, status, meta_template_id, language
      FROM message_templates
      WHERE id = ${id}
        AND account_id = ${accountId}
      LIMIT 1
    `)) as DbRow[]
    const existing = existingRows[0]
    if (!existing) {
      return NextResponse.json({ error: 'Template not found.' }, { status: 404 })
    }

    if (!existing.meta_template_id) {
      return NextResponse.json(
        {
          error:
            'This template was never submitted to Meta — use New Template to submit it instead.',
        },
        { status: 400 },
      )
    }

    if (!EDITABLE_STATUSES.has(existing.status)) {
      return NextResponse.json(
        {
          error: `Templates in status ${existing.status} cannot be edited. Allowed: APPROVED, REJECTED, PAUSED.`,
        },
        { status: 400 },
      )
    }

    if (payload.category === 'Authentication') {
      return NextResponse.json(
        {
          error:
            'AUTHENTICATION templates are not editable here — manage them in Meta WhatsApp Manager.',
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

    if (!isDryRun()) {
      const configRows = (await db.execute(sql`
        SELECT *
        FROM whatsapp_config
        WHERE account_id = ${accountId}
        LIMIT 1
      `)) as DbRow[]
      const config = configRows[0]
      if (!config) {
        return NextResponse.json(
          { error: 'WhatsApp not configured.' },
          { status: 400 },
        )
      }
      const accessToken = decrypt(config.access_token)

      // Image headers need a fresh Resumable-Upload handle on every edit
      // (Meta replaces components wholesale). Derive from header_media_url.
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
        await editMessageTemplate({
          metaTemplateId: existing.meta_template_id,
          accessToken,
          components: metaPayload.components,
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta edit failed.'
        await db.execute(sql`
          UPDATE message_templates
          SET submission_error = ${message},
              last_submitted_at = NOW(),
              updated_at = NOW()
          WHERE id = ${id}
            AND account_id = ${accountId}
        `)
        return NextResponse.json({ error: message }, { status: 502 })
      }
    }

    // Meta accepted the edit — status flips back to PENDING for review.
    let row: DbRow
    try {
      const rows = (await db.execute(sql`
        UPDATE message_templates
        SET category = ${payload.category},
            header_type = ${payload.header_type ?? null},
            header_content = ${payload.header_content ?? null},
            header_media_url = ${payload.header_media_url ?? null},
            header_handle = ${payload.header_handle ?? null},
            body_text = ${payload.body_text},
            footer_text = ${payload.footer_text ?? null},
            buttons = ${payload.buttons ? JSON.stringify(payload.buttons) : null}::jsonb,
            sample_values = ${payload.sample_values ? JSON.stringify(payload.sample_values) : null}::jsonb,
            status = 'PENDING',
            submission_error = NULL,
            rejection_reason = NULL,
            last_submitted_at = NOW(),
            updated_at = NOW()
        WHERE id = ${id}
          AND account_id = ${accountId}
        RETURNING *
      `)) as DbRow[]
      row = rows[0]
    } catch (updErr) {
      const message = updErr instanceof Error ? updErr.message : String(updErr)
      return NextResponse.json(
        {
          error: `Edited on Meta but failed to save locally: ${message}. Run "Sync from Meta" to recover.`,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      template: row,
      dry_run: isDryRun(),
    })
  } catch (error) {
    console.error('Error editing template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to edit template.',
      },
      { status: 500 },
    )
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: 'Invalid template id.' },
        { status: 400 },
      )
    }
    const user = await getSession()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Same account-scoping rationale as the PATCH handler above —
    // teammates need to be able to operate on shared templates +
    // the shared whatsapp_config.
    const accountId = await resolveAccountId(user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const existingRows = (await db.execute(sql`
      SELECT id, name, meta_template_id
      FROM message_templates
      WHERE id = ${id}
        AND account_id = ${accountId}
      LIMIT 1
    `)) as DbRow[]
    const existing = existingRows[0]
    if (!existing) {
      return NextResponse.json({ error: 'Template not found.' }, { status: 404 })
    }

    if (existing.meta_template_id && !isDryRun()) {
      const configRows = (await db.execute(sql`
        SELECT *
        FROM whatsapp_config
        WHERE account_id = ${accountId}
        LIMIT 1
      `)) as DbRow[]
      const config = configRows[0]
      if (!config || !config.waba_id) {
        return NextResponse.json(
          { error: 'WhatsApp not configured — cannot delete on Meta.' },
          { status: 400 },
        )
      }
      const accessToken = decrypt(config.access_token)
      try {
        await deleteMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          name: existing.name,
          metaTemplateId: existing.meta_template_id,
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta delete failed.'
        return NextResponse.json({ error: message }, { status: 502 })
      }
    }

    try {
      await db.execute(sql`
        DELETE FROM message_templates
        WHERE id = ${id}
          AND account_id = ${accountId}
      `)
    } catch (delErr) {
      const message = delErr instanceof Error ? delErr.message : String(delErr)
      return NextResponse.json(
        {
          error: `Deleted on Meta but failed to delete locally: ${message}.`,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, dry_run: isDryRun() })
  } catch (error) {
    console.error('Error deleting template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to delete template.',
      },
      { status: 500 },
    )
  }
}
