import { eq } from 'drizzle-orm'

import { db, pgClient } from '@/lib/db'
import { profiles } from '@/lib/db/schema'
import { getSession } from '@/lib/auth/session'

// SSE realtime endpoint backed by PostgreSQL LISTEN/NOTIFY.
//
// Migration 027 installs AFTER triggers on messages / conversations /
// member_presence that `pg_notify('wacrm_realtime', …)` with a small
// JSON payload. This route opens a dedicated LISTEN connection per
// subscriber and forwards events scoped to the caller's account as SSE.
//
// The browser consumes this via `new EventSource('/api/realtime')`
// (see src/hooks/use-realtime.ts and use-presence.ts).

export const dynamic = 'force-dynamic'
// LISTEN needs a long-lived Node connection — not the Edge runtime.
export const runtime = 'nodejs'

interface NotifyPayload {
  table: string
  op: 'INSERT' | 'UPDATE' | 'DELETE'
  id: string | null
  account_id: string | null
  conversation_id: string | null
}

export async function GET() {
  const sessionUser = await getSession()
  if (!sessionUser) {
    return new Response('Unauthorized', { status: 401 })
  }

  const prof = await db
    .select({ accountId: profiles.accountId })
    .from(profiles)
    .where(eq(profiles.userId, sessionUser.id))
    .limit(1)
  const accountId = prof[0]?.accountId
  if (!accountId) {
    return new Response('No account', { status: 403 })
  }

  const encoder = new TextEncoder()

  let closed = false
  let unlisten: (() => Promise<void>) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null

  const cleanup = async () => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    if (unlisten) {
      try {
        await unlisten()
      } catch {
        // ignore
      }
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        )
      }

      controller.enqueue(encoder.encode(': connected\n\n'))
      send('ready', { accountId })

      heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(': ping\n\n'))
        } catch {
          // stream closed underneath us
        }
      }, 25_000)

      try {
        const sub = await pgClient.listen('wacrm_realtime', (raw) => {
          let payload: NotifyPayload
          try {
            payload = JSON.parse(raw) as NotifyPayload
          } catch {
            return
          }
          // Scope to this subscriber's account when the payload carries
          // one (conversations / member_presence). messages have no
          // account_id column, so they pass through and the client
          // refetches the affected conversation.
          if (payload.account_id && payload.account_id !== accountId) {
            return
          }
          const eventName =
            payload.table === 'messages'
              ? 'message'
              : payload.table === 'conversations'
                ? 'conversation'
                : payload.table === 'member_presence'
                  ? 'presence'
                  : 'change'
          send(eventName, payload)
        })
        unlisten = sub.unlisten
      } catch (err) {
        console.error('[api/realtime] listen error:', err)
      }
    },
    async cancel() {
      await cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}
