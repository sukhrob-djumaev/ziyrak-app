export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * PLAN.md §29 — fixed-window limiter contract. `InMemoryRateLimiter` is
 * correct for exactly one replica; `RedisRateLimiter` enforces the same
 * window across all replicas. Both pass the same contract suite
 * (tests/helpers/rate-limiter-contract.ts).
 */
export interface RateLimiter {
  check(key: string, config: RateLimitConfig): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}
