import { createHash } from "node:crypto";
import type { RedisClient } from "@/lib/redis/client";
import type { RateLimitConfig, RateLimitResult, RateLimiter } from "./types";

/**
 * Fixed window, one atomic round trip: INCR, start the window's TTL on the
 * first hit, and return the count with the time left. Atomic in Lua so two
 * replicas can never both see "first hit", and a counter can never be left
 * without an expiry (a key that never expires would block a client forever).
 */
const CHECK_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

/** Keys embed client-supplied text (forwarded IPs, connection ids): hash them so a request cannot choose the size of a Redis key. */
const redisKey = (prefix: string, key: string) => `${prefix}${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly client: Pick<RedisClient, "eval" | "del">,
    private readonly prefix: string
  ) {}

  async check(key: string, config: RateLimitConfig): Promise<RateLimitResult> {
    const reply = (await this.client.eval(CHECK_SCRIPT, {
      keys: [redisKey(this.prefix, key)],
      arguments: [String(config.windowMs)],
    })) as [number, number];
    const [count, ttl] = reply;
    const resetAt = Date.now() + ttl;
    if (count > config.maxRequests) return { allowed: false, remaining: 0, resetAt };
    return { allowed: true, remaining: config.maxRequests - count, resetAt };
  }

  async reset(key: string): Promise<void> {
    await this.client.del(redisKey(this.prefix, key));
  }
}
