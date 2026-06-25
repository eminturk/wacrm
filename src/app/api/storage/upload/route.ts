import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { putObject } from '@/lib/storage/s3'
import { buildMediaPath } from '@/lib/storage/upload-media'

export const runtime = 'nodejs'

// POST multipart/form-data { bucket, file } — upload account-scoped
// media to S3. The object key is `<bucket>/account-<accountId>/...`
// so a future per-bucket policy can still distinguish them while a
// single S3 bucket backs everything.
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }

  const form = await request.formData()
  const bucket = String(form.get('bucket') ?? '').trim()
  const file = form.get('file')

  if (!bucket) {
    return NextResponse.json({ error: 'Missing bucket' }, { status: 400 })
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file' }, { status: 400 })
  }

  const objectPath = buildMediaPath(ctx.accountId, file.name)
  const key = `${bucket}/${objectPath}`
  const buffer = Buffer.from(await file.arrayBuffer())

  try {
    const url = await putObject(key, buffer, file.type || undefined)
    return NextResponse.json({ publicUrl: url, path: key })
  } catch (err) {
    console.error('[api/storage/upload] error:', err)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }
}
