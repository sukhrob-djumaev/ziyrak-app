import type { RateLimitConfig, RateLimitResult, RateLimiter } from "./types";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const CLEANUP_INTERVAL = 5 * 60 * 1000;
/** A full limiter sweeps for expired entries at most this often, so a flood of new keys cannot turn the sweep into a CPU attack. */
const FULL_SWEEP_MIN_INTERVAL = 1000;
const DEFAULT_MAX_KEYS = 50_000;

export class InMemoryRateLimiter implements RateLimiter {
  private readonly store = new Map<string, RateLimitEntry>();
  private lastCleanup = Date.now();
  private lastFullSweep = 0;

  /**
   * `maxKeys` bounds memory: a client that rotates its (forwarded) address on every request would otherwise
   * create a key per request. When full, expired entries are dropped first, then the oldest. Limits stay
   * best-effort in a flood (an evicted counter restarts); use Redis (`REDIS_URL`) for strict shared limits.
   */
  constructor(private readonly maxKeys: number = DEFAULT_MAX_KEYS) {}

  get size(): number {
    return this.store.size;
  }

  private makeRoom(now: number): void {
    if (now - this.lastFullSweep >= FULL_SWEEP_MIN_INTERVAL) {
      this.lastFullSweep = now;
      for (const [key, entry] of this.store.entries()) {
        if (now > entry.resetAt) this.store.delete(key);
      }
    }
    while (this.store.size >= this.maxKeys) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }

  private cleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanup < CLEANUP_INTERVAL) return;
    this.lastCleanup = now;
    for (const [key, entry] of this.store) {
      if (now > entry.resetAt) this.store.delete(key);
    }
  }

  async check(key: string, config: RateLimitConfig): Promise<RateLimitResult> {
    this.cleanup();

    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || now > entry.resetAt) {
      if (!entry) this.makeRoom(now);
      else this.store.delete(key); // re-insert so insertion order tracks recency of the new window
      this.store.set(key, { count: 1, resetAt: now + config.windowMs });
      return { allowed: true, remaining: config.maxRequests - 1, resetAt: now + config.windowMs };
    }

    entry.count++;

    if (entry.count > config.maxRequests) {
      return { allowed: false, remaining: 0, resetAt: entry.resetAt };
    }
    return { allowed: true, remaining: config.maxRequests - entry.count, resetAt: entry.resetAt };
  }

  async reset(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Test-only: drop every counter. */
  clear(): void {
    this.store.clear();
  }
}
