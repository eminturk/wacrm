/**
 * Per-key rate limiter — Redis-backed when REDIS_URL is set, otherwise
 * falls back to the original in-memory fixed-window implementation.
 *
 * Redis mode:   uses a Lua INCR+EXPIRE script for atomic fixed-window
 *               counting. Works correctly across multiple Node processes
 *               and Vercel serverless instances.
 *
 * In-memory mode (fallback):
 *               A single Node process holds the Map, so horizontal scale
 *               silently defeats the limit. Suitable for single-instance
 *               VPS deployments. No background timer — safe in serverless
 *               runtimes that don't keep timers alive across requests.
 *
 * The public interface (`checkRateLimit`, `rateLimitResponse`, `RATE_LIMITS`)
 * is identical in both modes — call sites never change.
 */

import { NextResponse } from 'next/server';
import { redisEnabled, getRedis } from '@/lib/redis';

export interface RateLimitOptions {
  /** Max requests allowed in `windowMs`. */
  limit: number;
  /** Window size, milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  success: boolean;
  /** Requests still allowed in the current window. */
  remaining: number;
  /** Unix ms when the bucket refills. */
  reset: number;
  limit: number;
}

interface Entry {
  count: number;
  resetAt: number;
}

// ============================================================
// Redis fixed-window implementation (async)
// ============================================================

/**
 * Lua script: atomically increment the counter for `key` and set its
 * TTL on first increment. Returns [count, ttlMs] where ttlMs is the
 * remaining window in milliseconds.
 */
const RATE_LIMIT_LUA = `
local key    = KEYS[1]
local limit  = tonumber(ARGV[1])
local window = tonumber(ARGV[2])   -- milliseconds

local count = redis.call('INCR', key)
if count == 1 then
  redis.call('PEXPIRE', key, window)
end

local ttl = redis.call('PTTL', key)
return { count, ttl }
`

/**
 * Redis-backed fixed-window rate check. Returns a RateLimitResult
 * just like the in-memory version but works across multiple processes.
 */
export async function checkRateLimitRedis(
  key: string,
  { limit, windowMs }: RateLimitOptions,
): Promise<RateLimitResult> {
  try {
    const client = getRedis()
    const result = (await client.eval(
      RATE_LIMIT_LUA,
      1,
      `rl:${key}`,
      limit,
      windowMs,
    )) as [number, number]
    const [count, ttlMs] = result
    const now = Date.now()
    const reset = now + Math.max(ttlMs, 0)
    const remaining = Math.max(0, limit - count)
    return { success: count <= limit, remaining, reset, limit }
  } catch (err) {
    // Redis error: fail open (allow) so the app keeps working.
    console.error('[rate-limit] Redis error, failing open:', (err as Error).message)
    return { success: true, remaining: limit - 1, reset: Date.now() + windowMs, limit }
  }
}

// ============================================================
// In-memory fixed-window implementation (sync, single-process)
// ============================================================

const buckets = new Map<string, Entry>();

// Opportunistic cleanup. Running a sweep on every call would be
// quadratic; running it 1-in-N lets the Map self-drain without a
// background timer.
const LIGHT_SWEEP_EVERY = 1000;
let callsSinceSweep = 0;

function sweepExpired(now: number) {
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}

function checkRateLimitMemory(
  key: string,
  { limit, windowMs }: RateLimitOptions,
): RateLimitResult {
  const now = Date.now();

  callsSinceSweep += 1;
  if (callsSinceSweep >= LIGHT_SWEEP_EVERY) {
    callsSinceSweep = 0;
    sweepExpired(now);
  }

  const entry = buckets.get(key);

  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { success: true, remaining: limit - 1, reset: now + windowMs, limit };
  }

  if (entry.count >= limit) {
    return { success: false, remaining: 0, reset: entry.resetAt, limit };
  }

  entry.count += 1;
  return {
    success: true,
    remaining: limit - entry.count,
    reset: entry.resetAt,
    limit,
  };
}

// ============================================================
// Unified export — Redis when available, in-memory otherwise.
// ============================================================

/**
 * Check rate limit for `key`. Automatically uses Redis when REDIS_URL
 * is set, otherwise falls back to the in-memory store.
 *
 * NOTE: When Redis is active this function is **async**. When using
 * the in-memory fallback it still returns a Promise so call sites are
 * identical regardless of backend.
 */
export async function checkRateLimit(
  key: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  if (redisEnabled) {
    return checkRateLimitRedis(key, opts)
  }
  return checkRateLimitMemory(key, opts)
}

/**
 * Standard 429 response with the headers clients expect (RFC 6585 +
 * draft-ietf-httpapi-ratelimit-headers). Callers just `return` this.
 */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  const retryAfterSec = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return NextResponse.json(
    {
      error: 'Rate limit exceeded',
      retry_after_seconds: retryAfterSec,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)),
      },
    },
  );
}

/** Preconfigured budgets, tweak here not at call sites. */
export const RATE_LIMITS = {
  /** Individual message send. 60/min per user = one per second
   *  sustained, comfortable for a live human typing. */
  send: { limit: 60, windowMs: 60_000 },
  /** Broadcast dispatch. 5/min per user — even a 1 000-recipient
   *  broadcast is one call; this caps the rate at which a single user
   *  can launch campaigns, not the messages inside one. */
  broadcast: { limit: 5, windowMs: 60_000 },
  /** Reaction add/swap/remove. More permissive than send — users
   *  fidget with reactions and a single "swap" is actually two calls
   *  (remove + add) under the hood. */
  react: { limit: 120, windowMs: 60_000 },
  /** Invitation peek (public, per-IP). 30/min lets a forwarded link
   *  retry a handful of times under flaky connectivity without
   *  enabling brute-force token enumeration. With 256-bit tokens the
   *  enumeration risk is theoretical; this is belt-and-braces. */
  invitationPeek: { limit: 30, windowMs: 60_000 },
  /** Invitation redeem (authed, per-IP+user). Tighter than peek —
   *  successful redemption mutates two profiles and an invite row, so
   *  the abuse surface is "spam join attempts." */
  invitationRedeem: { limit: 10, windowMs: 60_000 },
  /** Admin-only account / member-management actions: create/revoke
   *  invitation, rename account, change member role, remove member,
   *  transfer ownership. 30/min per user is comfortably above any
   *  realistic legitimate use (the Members tab is a clicks-only UI)
   *  while still bounding accidental abuse from a script run in a
   *  loop or a compromised admin session spamming role flips. */
  adminAction: { limit: 30, windowMs: 60_000 },
  /** Public REST API (`/api/v1/*`), keyed per API key. 120/min ≈ 2
   *  req/s sustained — comfortable for a polling integration or an
   *  automation firing on inbound events, while bounding a runaway
   *  script. Like every bucket here it's per-process; a multi-
   *  instance deploy needs the Redis swap described at the top of
   *  this file (the per-key call sites don't change). */
  publicApi: { limit: 120, windowMs: 60_000 },
} as const;

/** Test-only helper. Clears the in-memory state so unit tests don't
 *  leak buckets across files. Not wired up in production code. */
export function __resetRateLimitForTests() {
  buckets.clear();
  callsSinceSweep = 0;
}
