import { NextResponse } from 'next/server'
import { and, asc, eq } from 'drizzle-orm'
import { getSession } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { flowNodes, flows } from '@/lib/db/schema'

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

const nodeSelect = {
  id: flowNodes.id,
  flow_id: flowNodes.flowId,
  node_key: flowNodes.nodeKey,
  node_type: flowNodes.nodeType,
  config: flowNodes.config,
  position_x: flowNodes.positionX,
  position_y: flowNodes.positionY,
  created_at: flowNodes.createdAt,
}

async function requireOwnership(
  flowId: string,
): Promise<
  | { ok: true; userId: string }
  | { ok: false; status: number; body: { error: string } }
> {
  const user = await getSession()
  if (!user) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } }
  }
  const [flow] = await db
    .select({ id: flows.id })
    .from(flows)
    .where(and(eq(flows.id, flowId), eq(flows.userId, user.id)))
    .limit(1)
  if (!flow) {
    return { ok: false, status: 404, body: { error: 'Not found' } }
  }
  return { ok: true, userId: user.id }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const guard = await requireOwnership(id)
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status })

    const [flowRows, nodes] = await Promise.all([
      db.select(flowSelect).from(flows).where(eq(flows.id, id)).limit(1),
      db
        .select(nodeSelect)
        .from(flowNodes)
        .where(eq(flowNodes.flowId, id))
        .orderBy(asc(flowNodes.createdAt)),
    ])
    const flow = flowRows[0]
    if (!flow) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json({ flow, nodes })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

interface PutBody {
  name?: string
  description?: string | null
  trigger_type?: 'keyword' | 'first_inbound_message' | 'manual'
  trigger_config?: Record<string, unknown>
  entry_node_id?: string | null
  fallback_policy?: Record<string, unknown>
  nodes?: Array<{
    node_key: string
    node_type: string
    config: Record<string, unknown>
    position_x?: number
    position_y?: number
  }>
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const guard = await requireOwnership(id)
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status })

    const body = (await request.json().catch(() => null)) as PutBody | null
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (body.name !== undefined && !body.name.trim()) {
      return NextResponse.json(
        { error: 'name cannot be empty' },
        { status: 400 },
      )
    }

    const flowPatch: Partial<typeof flows.$inferInsert> = {
      updatedAt: new Date(),
    }
    if (body.name !== undefined) flowPatch.name = body.name.trim()
    if (body.description !== undefined)
      flowPatch.description = body.description
    if (body.trigger_type !== undefined) flowPatch.triggerType = body.trigger_type
    if (body.trigger_config !== undefined)
      flowPatch.triggerConfig = body.trigger_config
    if (body.entry_node_id !== undefined)
      flowPatch.entryNodeId = body.entry_node_id
    if (body.fallback_policy !== undefined)
      flowPatch.fallbackPolicy = body.fallback_policy

    await db.update(flows).set(flowPatch).where(eq(flows.id, id))

    if (body.nodes !== undefined) {
      await db.delete(flowNodes).where(eq(flowNodes.flowId, id))
      if (body.nodes.length > 0) {
        await db.insert(flowNodes).values(
          body.nodes.map((n) => ({
            flowId: id,
            nodeKey: n.node_key,
            nodeType: n.node_type,
            config: n.config,
            positionX: n.position_x ?? 0,
            positionY: n.position_y ?? 0,
          })),
        )
      }
    }

    const [flowRows, nodes] = await Promise.all([
      db.select(flowSelect).from(flows).where(eq(flows.id, id)).limit(1),
      db
        .select(nodeSelect)
        .from(flowNodes)
        .where(eq(flowNodes.flowId, id))
        .orderBy(asc(flowNodes.createdAt)),
    ])
    return NextResponse.json({ flow: flowRows[0], nodes })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const guard = await requireOwnership(id)
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status })

    await db.delete(flows).where(eq(flows.id, id))
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
