import { NextResponse } from 'next/server'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { getSession } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { contacts, flowRunEvents, flowRuns, flows } from '@/lib/db/schema'

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params

    const user = await getSession()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const [flow] = await db
      .select({ id: flows.id, name: flows.name })
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.userId, user.id)))
      .limit(1)
    if (!flow) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const runRows = await db
      .select({
        id: flowRuns.id,
        status: flowRuns.status,
        current_node_key: flowRuns.currentNodeKey,
        started_at: flowRuns.startedAt,
        last_advanced_at: flowRuns.lastAdvancedAt,
        ended_at: flowRuns.endedAt,
        end_reason: flowRuns.endReason,
        vars: flowRuns.vars,
        reprompt_count: flowRuns.repromptCount,
        contact_id: contacts.id,
        contact_name: contacts.name,
        contact_phone: contacts.phone,
      })
      .from(flowRuns)
      .leftJoin(contacts, eq(flowRuns.contactId, contacts.id))
      .where(eq(flowRuns.flowId, id))
      .orderBy(desc(flowRuns.startedAt))
      .limit(50)

    const runs = runRows.map((r) => ({
      id: r.id,
      status: r.status,
      current_node_key: r.current_node_key,
      started_at: r.started_at,
      last_advanced_at: r.last_advanced_at,
      ended_at: r.ended_at,
      end_reason: r.end_reason,
      vars: r.vars,
      reprompt_count: r.reprompt_count,
      contact: r.contact_id
        ? { id: r.contact_id, name: r.contact_name, phone: r.contact_phone }
        : null,
    }))

    const runIds = runs.map((r) => r.id)
    let events: Array<{
      flow_run_id: string
      event_type: string
      node_key: string | null
      payload: Record<string, unknown>
      created_at: Date | null
    }> = []
    if (runIds.length > 0) {
      try {
        events = await db
          .select({
            flow_run_id: flowRunEvents.flowRunId,
            event_type: flowRunEvents.eventType,
            node_key: flowRunEvents.nodeKey,
            payload: flowRunEvents.payload,
            created_at: flowRunEvents.createdAt,
          })
          .from(flowRunEvents)
          .where(inArray(flowRunEvents.flowRunId, runIds))
          .orderBy(asc(flowRunEvents.createdAt)) as typeof events
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[flows-runs] events fetch failed:', message)
      }
    }

    return NextResponse.json({
      flow,
      runs,
      events,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
