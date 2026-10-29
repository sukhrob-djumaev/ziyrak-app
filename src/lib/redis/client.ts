import { createClient } from "redis";
import { logger } from "@/lib/observability/logger";

/**
 * PLAN.md §29 — the one place that knows how to talk to Redis. Redis is
 * never a source of truth (cache, rate limits, ephemeral pub/sub only), so
 * every caller must treat "Redis unavailable" as a degraded mode, not an
 * error: `getSharedRedis()` answers `null` instead of throwing, and the
 * clients fail commands immediately while disconnected (no offline queue)
 * rather than letting a request hang behind a dead connection.
 */
export type RedisClient = ReturnType<typeof createRedisClient>;

export function redisUrl(): string | undefined {
  const url = process.env.REDIS_URL?.trim();
  return url ? url : undefined;
}

/**
 * Prefix for every key this app writes. Read at call time so a test
 * worker can namespace its own keys (tests/setup.ts) and two deployments
 * can share one Redis.
 */
export function redisKeyPrefix(): string {
  return process.env.REDIS_KEY_PREFIX ?? "ziyrak:";
}

export function createRedisClient(url: string) {
  const client = createClient({
    url,
    disableOfflineQueue: true,
    // pingInterval tears down a connection that went silent (partition, hung
    // Redis) instead of waiting minutes for OS keepalive to notice.
    pingInterval: 5_000,
    socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 5_000) },
  });
  // An unhandled 'error' event would crash the process; connection loss is
  // already surfaced to callers as command failures.
  client.on("error", (error) => logger.warn("[Redis] client error", { error: String(error) }));
  // Never keep a short-lived process (a test worker, a script) alive.
  client.unref();
  return client;
}

let shared: RedisClient | null = null;
let connecting: Promise<RedisClient | null> | null = null;
let lastFailureAt = 0;
const RETRY_AFTER_FAILURE_MS = 5_000;
export const CONNECT_TIMEOUT_MS = 1_000;
/** Budget for one cache/rate-limit command: Redis must never sit on the request's critical path. */
export const COMMAND_TIMEOUT_MS = 250;
const BREAKER_OPEN_MS = 5_000;
let breakerOpenUntil = 0;

/** Report a failed/timed-out command: callers fall back to in-memory for a short window instead of paying the timeout on every request. */
export function markRedisFailure(): void {
  breakerOpenUntil = Date.now() + BREAKER_OPEN_MS;
}

/** Run one Redis command with a short budget; a timeout opens the circuit breaker. */
export async function redisCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await withTimeout(run(), COMMAND_TIMEOUT_MS);
  } catch (error) {
    markRedisFailure();
    throw error;
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis connect timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The process-wide client for cache/rate-limit use, or `null` when
 * `REDIS_URL` is unset or Redis is currently unreachable (callers fall back
 * to their in-memory behavior).
 */
export async function getSharedRedis(): Promise<RedisClient | null> {
  const url = redisUrl();
  if (!url) return null;
  if (Date.now() < breakerOpenUntil) return null;
  if (shared?.isReady) return shared;
  if (connecting) return connecting;
  if (Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS && !shared) return null;

  if (shared) {
    // Created earlier and reconnecting by itself; do not hand out a client
    // whose commands would fail.
    return null;
  }

  connecting = (async () => {
    const client = createRedisClient(url);
    try {
      // `connect()` retries forever by design (the reconnect strategy), so an
      // unreachable Redis would otherwise hang every caller on first use.
      await withTimeout(client.connect(), CONNECT_TIMEOUT_MS);
      shared = client;
      logger.info("[Redis] connected");
      return client;
    } catch (error) {
      lastFailureAt = Date.now();
      logger.warn("[Redis] connection failed, using in-memory fallback", { error: String(error) });
      client.destroy();
      return null;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

export async function closeSharedRedis(): Promise<void> {
  const client = shared;
  shared = null;
  lastFailureAt = 0;
  if (client?.isOpen) await client.close();
}
