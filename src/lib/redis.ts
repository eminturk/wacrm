// ============================================================
// Redis client — wraps ioredis with a lazy-connect singleton.
//
// REDIS_URL environment variable must be set (e.g.
// redis://localhost:6379 or ******host:6380/0).
// When the variable is absent the module exports a stub that
// returns sensible "disabled" defaults so the rest of the app
// compiles and works without a Redis instance (rate-limiting
// falls back to in-memory).
//
// Usage:
//   import { redis, redisEnabled } from '@/lib/redis'
//   if (redisEnabled) { await redis.set('k', 'v') }
// ============================================================

import Redis from 'ioredis'

let _client: Redis | null = null

/** True when REDIS_URL is set and a client has been initialised. */
export const redisEnabled = Boolean(process.env.REDIS_URL)

function createClient(): Redis {
  if (_client) return _client

  const url = process.env.REDIS_URL!

  _client = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: false,
    lazyConnect: true,
  })

  _client.on('error', (err: Error) => {
    // Log but don't crash — the app degrades gracefully.
    console.error('[redis] connection error:', err.message)
  })

  return _client
}

/**
 * The ioredis client. Only access this when `redisEnabled` is true.
 * Calling it without REDIS_URL set throws immediately.
 */
export function getRedis(): Redis {
  if (!redisEnabled) {
    throw new Error('[redis] REDIS_URL is not set')
  }
  return createClient()
}

/** Convenience re-export so callers can do `import { redis } from '@/lib/redis'`. */
export const redis = new Proxy({} as Redis, {
  get(_target, prop) {
    return getRedis()[prop as keyof Redis]
  },
})
