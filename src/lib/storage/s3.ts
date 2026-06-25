// ============================================================
// S3-compatible object storage client (AWS SDK v3).
//
// Replaces Supabase Storage. Works with AWS S3, MinIO, Cloudflare R2,
// DigitalOcean Spaces, etc. Configure via env:
//
//   S3_ENDPOINT          — e.g. https://s3.amazonaws.com or your MinIO/R2 URL
//   S3_REGION            — e.g. us-east-1 (any value for MinIO)
//   S3_BUCKET            — bucket name
//   S3_ACCESS_KEY_ID     — credentials
//   S3_SECRET_ACCESS_KEY — credentials
//   S3_PUBLIC_URL        — base URL objects are publicly served from
//                          (defaults to `${S3_ENDPOINT}/${S3_BUCKET}`)
//
// Server-only — never import from a client component (the credentials
// must not reach the browser).
// ============================================================

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export const S3_BUCKET = process.env.S3_BUCKET ?? ''

let _client: S3Client | null = null

/** Lazily-constructed shared S3 client. */
export function s3(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: process.env.S3_REGION ?? 'us-east-1',
      endpoint: process.env.S3_ENDPOINT,
      // Path-style addressing works across MinIO / R2 / Spaces and AWS.
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      },
    })
  }
  return _client
}

/**
 * Public URL for an object key. Mirrors the path convention used by
 * `buildMediaPath`:  `${S3_PUBLIC_URL}/${key}`.
 */
export function publicUrl(key: string): string {
  const base =
    process.env.S3_PUBLIC_URL ??
    `${process.env.S3_ENDPOINT ?? ''}/${S3_BUCKET}`
  return `${base.replace(/\/$/, '')}/${key}`
}

/** Upload an object. Returns the object's public URL. */
export async function putObject(
  key: string,
  body: Buffer | Uint8Array,
  contentType?: string,
): Promise<string> {
  await s3().send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: '3600',
    }),
  )
  return publicUrl(key)
}

/** Delete an object (best-effort; throws on hard failures). */
export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }))
}

/** Presigned GET URL — for time-limited access to a private object. */
export async function presignGet(
  key: string,
  expiresInSeconds = 3600,
): Promise<string> {
  return getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
    { expiresIn: expiresInSeconds },
  )
}
