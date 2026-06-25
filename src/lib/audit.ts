/**
 * Audit log helper.
 *
 * All security-relevant events (logins, settings changes, message sends,
 * member management, opt-outs, IP allowlist updates) are written here.
 *
 * writeAuditLog is intentionally fire-and-forget — it never throws and
 * never blocks the caller. An audit write failure must not prevent the
 * actual operation from succeeding.
 */

import { db } from '@/lib/db'
import { auditLogs } from '@/lib/db/schema'

export interface AuditParams {
  /** The account the event belongs to. Null for pre-login events. */
  accountId?: string | null
  /** The user who performed the action. Null for system events. */
  userId?: string | null
  /**
   * Dot-namespaced action key.
   * Conventions:
   *   login.success | login.failure
   *   member.invite | member.remove | member.role_change
   *   settings.update (whatsapp, ip_allowlist, template, …)
   *   message.send | message.send_blocked_opted_out
   *   broadcast.send | broadcast.send_partial_failure
   *   contact.opted_out | contact.opted_in
   *   api_key.created | api_key.revoked
   */
  action: string
  resourceType?: string
  resourceId?: string
  /** Arbitrary extra context — avoid PII beyond what's needed. */
  metadata?: Record<string, unknown>
  ipAddress?: string | null
  userAgent?: string | null
}

/**
 * Write an audit log entry.
 * Always resolves (never rejects) — caller must not await for correctness.
 */
export async function writeAuditLog(params: AuditParams): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      accountId: params.accountId ?? null,
      userId: params.userId ?? null,
      action: params.action,
      resourceType: params.resourceType ?? null,
      resourceId: params.resourceId ?? null,
      metadata: params.metadata ?? {},
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
    })
  } catch (err) {
    // Audit failures must never surface to callers.
    console.error('[audit] writeAuditLog failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Extract the real client IP from the request, preferring the
 * X-Forwarded-For header (set by reverse proxies / CDNs).
 */
export function getClientIp(request: Request): string | null {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    // XFF can be a comma-separated list; the leftmost is the client.
    return xff.split(',')[0].trim()
  }
  return request.headers.get('x-real-ip') ?? null
}
