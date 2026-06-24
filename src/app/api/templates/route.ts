import { NextResponse } from 'next/server'
import { and, asc, desc, eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { messageTemplates } from '@/lib/db/schema'

export const runtime = 'nodejs'

const templateSelect = {
  id: messageTemplates.id,
  user_id: messageTemplates.userId,
  account_id: messageTemplates.accountId,
  name: messageTemplates.name,
  category: messageTemplates.category,
  language: messageTemplates.language,
  header_type: messageTemplates.headerType,
  header_content: messageTemplates.headerContent,
  body_text: messageTemplates.bodyText,
  footer_text: messageTemplates.footerText,
  buttons: messageTemplates.buttons,
  status: messageTemplates.status,
  sample_values: messageTemplates.sampleValues,
  meta_template_id: messageTemplates.metaTemplateId,
  rejection_reason: messageTemplates.rejectionReason,
  quality_score: messageTemplates.qualityScore,
  header_handle: messageTemplates.headerHandle,
  header_media_url: messageTemplates.headerMediaUrl,
  submission_error: messageTemplates.submissionError,
  last_submitted_at: messageTemplates.lastSubmittedAt,
  created_at: messageTemplates.createdAt,
  updated_at: messageTemplates.updatedAt,
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const url = new URL(request.url)
    const status = url.searchParams.get('status')
    const rows = await db
      .select(templateSelect)
      .from(messageTemplates)
      .where(
        status
          ? and(eq(messageTemplates.accountId, ctx.accountId), eq(messageTemplates.status, status))
          : eq(messageTemplates.accountId, ctx.accountId),
      )
      .orderBy(status === 'APPROVED' ? asc(messageTemplates.name) : desc(messageTemplates.createdAt))
    return NextResponse.json({ templates: rows })
  } catch (err) {
    return toErrorResponse(err)
  }
}
