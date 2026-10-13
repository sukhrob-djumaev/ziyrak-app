import { logger } from "@/lib/observability/logger";
import { getSharedRedis, redisCall, redisKeyPrefix } from "@/lib/redis/client";
import { InMemoryRateLimiter } from "@/lib/rate-limiters/in-memory";
import { RedisRateLimiter } from "@/lib/rate-limiters/redis";
import type { RateLimitConfig, RateLimitResult } from "@/lib/rate-limiters/types";

export type { RateLimitConfig, RateLimitResult };

export const RATE_LIMITS = {
  auth: { maxRequests: 5, windowMs: 60 * 1000 } as RateLimitConfig,
  // Sign-out needs a signature-valid token to do anything, so it is not a brute-force surface;
  // a shared NAT address must still be able to sign people out.
  logout: { maxRequests: 60, windowMs: 60 * 1000 } as RateLimitConfig,
  // Anonymous callers, API keys and anything without a valid session: keyed by client address.
  api: { maxRequests: 60, windowMs: 60 * 1000 } as RateLimitConfig,
  // A signed-in dashboard session, keyed by the verified session token. Higher than the per-address limit because each
  // page makes several background requests (account menu, approvals badge, live updates) and many people can
  // share one address (an office NAT, a tunnel), where a shared per-address budget would lock them all out.
  apiUser: { maxRequests: 600, windowMs: 60 * 1000 } as RateLimitConfig,
  // Opening the live event stream: a reconnect storm must not starve the same session's ordinary requests.
  stream: { maxRequests: 30, windowMs: 60 * 1000 } as RateLimitConfig,
  // Public provider webhook: generous for Meta's real bursts, but bounds the
  // pre-verification lookup/decrypt work an unauthenticated client can force.
  metaWebhook: { maxRequests: 1200, windowMs: 60 * 1000 } as RateLimitConfig,
} as const;

const memory = new InMemoryRateLimiter();
let warnedAt = 0;

/**
 * PLAN.md §29/§46.8 — fixed-window limiter. With `REDIS_URL` set the window
 * is shared by every replica, so the limit is enforced in aggregate rather
 * than multiplied by the replica count. Without Redis (the local default) or
 * while Redis is unreachable it degrades to a per-process window — never an
 * error, and never a request let through unlimited.
 */
export async function checkRateLimit(key: string, config: RateLimitConfig): Promise<RateLimitResult> {
  const client = await getSharedRedis();
  if (client) {
    try {
      return await redisCall(() => new RedisRateLimiter(client, `${redisKeyPrefix()}rl:`).check(key, config));
    } catch (error) {
      if (Date.now() - warnedAt > 30_000) {
        warnedAt = Date.now();
        logger.warn("[RateLimit] Redis check failed, using per-process fallback", { error: String(error) });
      }
    }
  }
  return memory.check(key, config);
}

export async function resetRateLimit(key: string): Promise<void> {
  await memory.reset(key);
  const client = await getSharedRedis();
  if (client) await redisCall(() => new RedisRateLimiter(client, `${redisKeyPrefix()}rl:`).reset(key)).catch(() => {});
}

/** Test-only: drop every counter, in memory and (when selected) in Redis under this process's key prefix. */
export async function resetRateLimitsForTesting(): Promise<void> {
  memory.clear();
  const client = await getSharedRedis();
  if (!client) return;
  const keys: string[] = [];
  for await (const batch of client.scanIterator({ MATCH: `${redisKeyPrefix()}rl:*`, COUNT: 200 })) {
    keys.push(...(Array.isArray(batch) ? batch : [batch]));
  }
  if (keys.length) await client.del(keys);
}
