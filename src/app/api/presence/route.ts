import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db, sql } from '@/lib/db'
import { memberPresence } from '@/lib/db/schema'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

export const runtime = 'nodejs'

// GET — presence rows for the caller's account.
export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const rows = await db
      .select({
        user_id: memberPresence.userId,
        status: memberPresence.status,
        last_seen_at: memberPresence.lastSeenAt,
      })
      .from(memberPresence)
      .where(eq(memberPresence.accountId, ctx.accountId))

    return NextResponse.json({
      rows: rows.map((r) => ({
        user_id: r.user_id,
        status: r.status,
        last_seen_at:
          r.last_seen_at instanceof Date
            ? r.last_seen_at.toISOString()
            : r.last_seen_at,
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

// POST { status } — heartbeat. Calls the touch_presence SQL function
// with the caller's user id (the function derives the account).
export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()

    let body: { status?: string }
    try {
      body = await request.json()
    } catch {
      body = {}
    }
    const status = body.status === 'away' ? 'away' : 'online'

    await db.execute(sql`SELECT touch_presence(${ctx.userId}::uuid, ${status})`)

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
