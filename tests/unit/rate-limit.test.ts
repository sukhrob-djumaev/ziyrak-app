import { describe, it, expect, beforeEach } from "vitest";
import {
  checkRateLimit,
  resetRateLimit,
  resetRateLimitsForTesting,
  type RateLimitConfig,
} from "@/lib/rate-limit";

describe("Rate Limiter", () => {
  const config: RateLimitConfig = { maxRequests: 3, windowMs: 1000 };

  beforeEach(async () => {
    await resetRateLimitsForTesting();
  });

  it("should allow requests within limit", async () => {
    const r1 = await checkRateLimit("test-key", config);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await checkRateLimit("test-key", config);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await checkRateLimit("test-key", config);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it("should block requests exceeding limit", async () => {
    for (let i = 0; i < 3; i++) {
      await checkRateLimit("block-key", config);
    }

    const r4 = await checkRateLimit("block-key", config);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
  });

  it("should track different keys independently", async () => {
    for (let i = 0; i < 3; i++) {
      await checkRateLimit("key-a", config);
    }

    const resultA = await checkRateLimit("key-a", config);
    expect(resultA.allowed).toBe(false);

    const resultB = await checkRateLimit("key-b", config);
    expect(resultB.allowed).toBe(true);
  });

  it("should reset after window expires", async () => {
    const shortConfig: RateLimitConfig = { maxRequests: 1, windowMs: 50 };

    await checkRateLimit("expire-key", shortConfig);
    const blocked = await checkRateLimit("expire-key", shortConfig);
    expect(blocked.allowed).toBe(false);

    await new Promise((r) => setTimeout(r, 60));

    const allowed = await checkRateLimit("expire-key", shortConfig);
    expect(allowed.allowed).toBe(true);
  });

  it("should provide correct resetAt timestamp", async () => {
    const before = Date.now();
    const result = await checkRateLimit("ts-key", config);
    const after = Date.now();

    expect(result.resetAt).toBeGreaterThanOrEqual(before + config.windowMs);
    expect(result.resetAt).toBeLessThanOrEqual(after + config.windowMs);
  });

  it("should support manual reset", async () => {
    for (let i = 0; i < 3; i++) {
      await checkRateLimit("reset-key", config);
    }

    expect((await checkRateLimit("reset-key", config)).allowed).toBe(false);

    await resetRateLimit("reset-key");

    expect((await checkRateLimit("reset-key", config)).allowed).toBe(true);
  });
});
