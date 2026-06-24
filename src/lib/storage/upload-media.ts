/**
 * Shared media-upload helper for the account-scoped S3 path convention
 * (`<bucket>/account-<account_id>/<timestamp>-<basename>.<ext>`).
 *
 * Migrated off Supabase Storage to S3: the browser can't hold S3
 * credentials, so the actual upload happens server-side via
 * `/api/storage/upload` (which resolves the caller's account from the
 * session cookie and writes the object). This module keeps the pure
 * path helpers (unit-tested) and a thin client wrapper around those
 * routes. Both the Flows builder (`node-config-form`) and the inbox
 * composer call this so the logic lives in exactly one place.
 */

/** 16 MB — matches the `file_size_limit` on both buckets (migrations 016/020/023). */
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Per-kind upload ceilings that mirror Meta's WhatsApp Cloud API caps so
 * a file that the bucket would accept (≤16 MB) but Meta would reject is
 * caught client-side BEFORE upload — otherwise it lands in storage as an
 * orphan and the send fails with a confusing 400. Images are Meta's
 * tightest cap at 5 MB; documents are held at the 16 MB bucket limit
 * (Meta allows 100 MB, but the bucket — and shared-hosting upload UX —
 * caps lower).
 */
export const MEDIA_MAX_BYTES_BY_KIND = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 16 * 1024 * 1024,
} as const;

/**
 * Build the account-scoped object path for an upload. Pure + exported so
 * it can be unit-tested without a Supabase client.
 *
 * - `basename` is stripped of its extension, lower-cased non-safe chars
 *   are collapsed to `_`, and it's capped at 40 chars (falls back to
 *   "file" when empty).
 * - The timestamp + the original name keep collisions between two
 *   concurrent uploads astronomically unlikely.
 */
export function buildMediaPath(
  accountId: string,
  fileName: string,
  now: number = Date.now(),
): string {
  // Only treat the trailing segment as an extension when there's a real
  // one — a bare name like "README" has no extension and falls back to
  // "bin" rather than becoming "readme".
  const hasExt = /\.[^.]+$/.test(fileName);
  const ext = hasExt ? fileName.split(".").pop()!.toLowerCase() : "bin";
  const safeBase =
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 40) || "file";
  return `account-${accountId}/${now}-${safeBase}.${ext}`;
}

export interface UploadAccountMediaResult {
  /** Public URL Meta can fetch at send time. */
  publicUrl: string;
  /** Storage object path (account-scoped). */
  path: string;
}

/**
 * Upload a file to an account-scoped S3 bucket and return its public
 * URL. Delegates to `/api/storage/upload`, which resolves the caller's
 * account from the session cookie. Throws with a user-facing message
 * on failure — callers surface it via a toast.
 *
 * Size validation is the caller's responsibility (limits can differ per
 * feature); `MEDIA_MAX_BYTES` is exported for the common case.
 */
export async function uploadAccountMedia(
  bucket: string,
  file: File,
): Promise<UploadAccountMediaResult> {
  const form = new FormData();
  form.append("bucket", bucket);
  form.append("file", file);

  const res = await fetch("/api/storage/upload", {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    let message = "Upload failed.";
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep default message
    }
    throw new Error(message);
  }

  const data = (await res.json()) as UploadAccountMediaResult;
  return data;
}

/**
 * Delete a previously-uploaded object. Used to GC media that was staged
 * (uploaded) but never sent — a cancelled draft or a failed Meta send.
 * Best-effort: callers fire-and-forget and swallow errors.
 */
export async function deleteAccountMedia(
  _bucket: string,
  path: string,
): Promise<void> {
  const res = await fetch("/api/storage/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    let message = "Delete failed.";
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep default message
    }
    throw new Error(message);
  }
}
