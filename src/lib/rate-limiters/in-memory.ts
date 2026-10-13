import type { RateLimitConfig, RateLimitResult, RateLimiter } from "./types";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const CLEANUP_INTERVAL = 5 * 60 * 1000;

export class InMemoryRateLimiter implements RateLimiter {
  private readonly store = new Map<string, RateLimitEntry>();
  private lastCleanup = Date.now();

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
