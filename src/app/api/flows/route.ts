import { NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'
import { getSession } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { flowNodes, flows, profiles } from '@/lib/db/schema'
import { getFlowTemplate } from '@/lib/flows/templates'
import { DEFAULT_FALLBACK_POLICY } from '@/lib/flows/types'

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

async function requireUser(): Promise<
  | { ok: true; userId: string; accountId: string }
  | { ok: false; status: number; body: { error: string } }
> {
  const user = await getSession()
  if (!user) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } }
  }
  const [profile] = await db
    .select({ account_id: profiles.accountId })
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1)
  if (!profile?.account_id) {
    return {
      ok: false,
      status: 403,
      body: { error: 'Your profile is not linked to an account.' },
    }
  }
  return { ok: true, userId: user.id, accountId: profile.account_id }
}

export async function GET() {
  try {
    const guard = await requireUser()
    if (!guard.ok) {
      return NextResponse.json(guard.body, { status: guard.status })
    }

    const data = await db
      .select(flowSelect)
      .from(flows)
      .where(eq(flows.accountId, guard.accountId))
      .orderBy(desc(flows.createdAt))
    return NextResponse.json({ flows: data })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const guard = await requireUser()
    if (!guard.ok) {
      return NextResponse.json(guard.body, { status: guard.status })
    }
    const { userId, accountId } = guard

    const body = (await request.json().catch(() => null)) as
      | {
          name?: string
          description?: string | null
          trigger_type?: 'keyword' | 'first_inbound_message' | 'manual'
          trigger_config?: Record<string, unknown>
          template_slug?: string
        }
      | null
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    if (body.template_slug) {
      const template = getFlowTemplate(body.template_slug)
      if (!template) {
        return NextResponse.json(
          { error: `Unknown template_slug "${body.template_slug}"` },
          { status: 400 },
        )
      }
      const [flow] = await db
        .insert(flows)
        .values({
          userId,
          accountId,
          name: body.name?.trim() || template.name,
          description: template.description,
          status: 'draft',
          triggerType: template.trigger_type,
          triggerConfig: template.trigger_config,
          entryNodeId: template.entry_node_id,
          fallbackPolicy: DEFAULT_FALLBACK_POLICY,
        })
        .returning(flowSelect)
      if (!flow) {
        return NextResponse.json({ error: 'flow insert failed' }, { status: 500 })
      }
      if (template.nodes.length > 0) {
        try {
          await db.insert(flowNodes).values(
            template.nodes.map((n) => ({
              flowId: flow.id,
              nodeKey: n.node_key,
              nodeType: n.node_type,
              config: n.config,
            })),
          )
        } catch (error) {
          await db.delete(flows).where(eq(flows.id, flow.id))
          const message = error instanceof Error ? error.message : 'Internal server error'
          return NextResponse.json({ error: message }, { status: 500 })
        }
      }
      return NextResponse.json({ flow }, { status: 201 })
    }

    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    const trigger_type = body.trigger_type ?? 'keyword'

    const [data] = await db
      .insert(flows)
      .values({
        userId,
        accountId,
        name: body.name.trim(),
        description: body.description ?? null,
        status: 'draft',
        triggerType: trigger_type,
        triggerConfig: body.trigger_config ?? {},
        fallbackPolicy: DEFAULT_FALLBACK_POLICY,
      })
      .returning(flowSelect)
    if (!data) {
      return NextResponse.json({ error: 'insert failed' }, { status: 500 })
    }
    return NextResponse.json({ flow: data }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
