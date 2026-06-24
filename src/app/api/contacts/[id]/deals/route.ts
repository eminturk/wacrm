import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { contacts, deals, pipelineStages } from '@/lib/db/schema';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)))
      .limit(1);
    if (!contact)
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });

    const rows = await db
      .select({
        id: deals.id,
        user_id: deals.userId,
        account_id: deals.accountId,
        pipeline_id: deals.pipelineId,
        stage_id: deals.stageId,
        contact_id: deals.contactId,
        conversation_id: deals.conversationId,
        assigned_to: deals.assignedTo,
        title: deals.title,
        value: deals.value,
        currency: deals.currency,
        notes: deals.notes,
        expected_close_date: deals.expectedCloseDate,
        status: deals.status,
        created_at: deals.createdAt,
        updated_at: deals.updatedAt,
        stage: {
          id: pipelineStages.id,
          pipeline_id: pipelineStages.pipelineId,
          name: pipelineStages.name,
          position: pipelineStages.position,
          color: pipelineStages.color,
          created_at: pipelineStages.createdAt,
        },
      })
      .from(deals)
      .leftJoin(pipelineStages, eq(deals.stageId, pipelineStages.id))
      .where(and(eq(deals.contactId, id), eq(deals.accountId, ctx.accountId)))
      .orderBy(desc(deals.createdAt));

    return NextResponse.json({
      deals: rows.map((deal) => ({ ...deal, value: Number(deal.value ?? 0) })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
