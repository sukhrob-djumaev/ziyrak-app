/**
 * Cache Abstraction Layer
 *
 * In-memory cache with optional Redis backend (PLAN.md §29/§46.8).
 * If REDIS_URL is set and reachable, uses Redis — shared by every replica.
 * Otherwise (local default, or Redis down) falls back to an in-memory Map.
 * This allows single-instance deployments to work without Redis,
 * while multi-instance deployments can use Redis for shared state.
 *
 * A cache is never the source of truth, so a Redis failure is a cache miss
 * (or a dropped write), never an error for the caller.
 */

import { logger } from "@/lib/observability/logger";
import { getSharedRedis, redisCall, redisKeyPrefix } from "@/lib/redis/client";

interface CacheEntry {
  value: string;
  expiresAt: number | null;
}

// In-memory fallback store
const memoryStore = new Map<string, CacheEntry>();
let warnedAt = 0;

function redisKey(key: string): string {
  return `${redisKeyPrefix()}cache:${key}`;
}

function warnFallback(error: unknown): void {
  if (Date.now() - warnedAt < 30_000) return;
  warnedAt = Date.now();
  logger.warn("[Cache] Redis operation failed, using in-memory fallback", { error: String(error) });
}

/**
 * Get a cached value.
 */
export async function cacheGet(key: string): Promise<string | null> {
  const redis = await getSharedRedis();

  if (redis) {
    try {
      return await redisCall(() => redis.get(redisKey(key)));
    } catch (error) {
      warnFallback(error);
    }
  }

  // In-memory fallback
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value;
}

/**
 * Set a cached value with optional TTL in seconds.
 */
export async function cacheSet(
  key: string,
  value: string,
  ttlSeconds?: number
): Promise<void> {
  const redis = await getSharedRedis();

  if (redis) {
    try {
      if (ttlSeconds) {
        await redisCall(() => redis.set(redisKey(key), value, { EX: ttlSeconds }));
      } else {
        await redisCall(() => redis.set(redisKey(key), value));
      }
      return;
    } catch (error) {
      warnFallback(error);
    }
  }

  // In-memory fallback
  memoryStore.set(key, {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
  });
}

/**
 * Delete a cached value.
 */
export async function cacheDel(key: string): Promise<void> {
  const redis = await getSharedRedis();

  if (redis) {
    try {
      await redisCall(() => redis.del(redisKey(key)));
    } catch (error) {
      warnFallback(error);
    }
  }

  memoryStore.delete(key);
}

/**
 * Check if Redis is available.
 */
export async function isCacheDistributed(): Promise<boolean> {
  const redis = await getSharedRedis();
  return redis !== null;
}
