import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { flowRunEvents, flowRuns, flows } from '@/lib/db/schema'
import { resolveFallbackPolicy } from '@/lib/flows/fallback'

export async function GET(request: Request) {
  try {
    const expected = process.env.AUTOMATION_CRON_SECRET
    if (!expected) {
      return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
    }
    const supplied = request.headers.get('x-cron-secret') ?? ''
    const suppliedBuf = Buffer.from(supplied)
    const expectedBuf = Buffer.from(expected)
    if (
      suppliedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(suppliedBuf, expectedBuf)
    ) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const now = new Date()
    const runs = await db
      .select({
        id: flowRuns.id,
        flow_id: flowRuns.flowId,
        user_id: flowRuns.userId,
        contact_id: flowRuns.contactId,
        last_advanced_at: flowRuns.lastAdvancedAt,
        fallback_policy: flows.fallbackPolicy,
      })
      .from(flowRuns)
      .innerJoin(flows, eq(flowRuns.flowId, flows.id))
      .where(eq(flowRuns.status, 'active'))

    if (!runs.length) return NextResponse.json({ swept: 0 })

    let swept = 0
    for (const r of runs) {
      const policy = resolveFallbackPolicy(r.fallback_policy ?? null)
      const lastAdvanced = new Date(r.last_advanced_at)
      const ageHours = (now.getTime() - lastAdvanced.getTime()) / (1000 * 60 * 60)
      if (ageHours < policy.on_timeout_hours) continue

      const updated = await db
        .update(flowRuns)
        .set({
          status: 'timed_out',
          endedAt: now,
          endReason: 'stale_sweep',
        })
        .where(and(eq(flowRuns.id, r.id), eq(flowRuns.status, 'active')))
        .returning({ id: flowRuns.id })

      if (updated.length > 0) {
        await db.insert(flowRunEvents).values({
          flowRunId: r.id,
          eventType: 'timeout',
          payload: {
            age_hours: Math.round(ageHours * 10) / 10,
            policy_hours: policy.on_timeout_hours,
          },
        })
        swept += 1
      }
    }

    return NextResponse.json({ swept })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    console.error('[flows-cron] active-run scan failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
