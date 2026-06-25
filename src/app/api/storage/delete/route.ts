import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { deleteObject } from '@/lib/storage/s3'

export const runtime = 'nodejs'

// POST { path } — delete a previously-uploaded object. The path must
// be scoped to the caller's account (`<bucket>/account-<accountId>/…`)
// so a caller can only remove objects under their own account folder.
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }

  let body: { path?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const path = body.path
  if (!path || !path.includes(`account-${ctx.accountId}/`)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
  }

  try {
    await deleteObject(path)
  } catch (err) {
    console.warn('[api/storage/delete] error:', err)
  }
  return NextResponse.json({ ok: true })
}
