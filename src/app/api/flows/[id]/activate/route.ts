import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { getSession } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { flowNodes, flows } from '@/lib/db/schema'
import { validateFlowForActivation } from '@/lib/flows/validate'

const flowSelect = {
  id: flows.id,
  user_id: flows.userId,
  account_id: flows.accountId,
  name: flows.name,
  description: flows.description,
  status: flows.status,
  trigger_type: flows.triggerType,
  trigger_config: flows.triggerConfig,
  entry_node_id: flows.entryNodeId,
  fallback_policy: flows.fallbackPolicy,
  execution_count: flows.executionCount,
  last_executed_at: flows.lastExecutedAt,
  created_at: flows.createdAt,
  updated_at: flows.updatedAt,
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params

    const user = await getSession()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await request.json().catch(() => null)) as
      | { status?: 'draft' | 'active' | 'archived' }
      | null
    const status = body?.status
    if (!status || !['draft', 'active', 'archived'].includes(status)) {
      return NextResponse.json(
        { error: "status must be one of 'draft' | 'active' | 'archived'" },
        { status: 400 },
      )
    }

    const [existing] = await db
      .select({ id: flows.id })
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.userId, user.id)))
      .limit(1)
    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    if (status === 'active') {
      const [flowRows, nodes] = await Promise.all([
        db
          .select({
            name: flows.name,
            trigger_type: flows.triggerType,
            trigger_config: flows.triggerConfig,
            entry_node_id: flows.entryNodeId,
          })
          .from(flows)
          .where(eq(flows.id, id))
          .limit(1),
        db
          .select({
            node_key: flowNodes.nodeKey,
            node_type: flowNodes.nodeType,
            config: flowNodes.config,
          })
          .from(flowNodes)
          .where(eq(flowNodes.flowId, id)),
      ])
      const flow = flowRows[0]
      if (!flow) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }
      const issues = validateFlowForActivation(
        flow as {
          name: string
          trigger_type: 'keyword' | 'first_inbound_message' | 'manual'
          trigger_config: Record<string, unknown>
          entry_node_id: string | null
        },
        nodes as Array<{
          node_key: string
          node_type: string
          config: Record<string, unknown>
        }>,
      )
      const blockers = issues.filter((i) => i.severity === 'error')
      if (blockers.length > 0) {
        return NextResponse.json(
          {
            error: 'Cannot activate flow — fix the issues below first.',
            issues,
          },
          { status: 422 },
        )
      }
    }

    const [updated] = await db
      .update(flows)
      .set({ status, updatedAt: new Date() })
      .where(eq(flows.id, id))
      .returning(flowSelect)
    return NextResponse.json({ flow: updated })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
