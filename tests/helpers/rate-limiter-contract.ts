import { describe, it, expect } from "vitest";
import type { RateLimiter } from "@/lib/rate-limiters/types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * PLAN.md §34.1/§46.8 — one behavior suite every `RateLimiter` must pass
 * identically from the caller's perspective (in-memory and Redis).
 * `create` must return a limiter whose keys are isolated from every other
 * call's, so tests never see each other's counters.
 */
export function describeRateLimiterContract(name: string, create: () => RateLimiter | Promise<RateLimiter>, opts: { skip?: boolean } = {}) {
  describe.skipIf(opts.skip)(`RateLimiter contract: ${name}`, () => {
    const config = { maxRequests: 3, windowMs: 1000 };

    it("allows requests up to the limit, counting remaining down", async () => {
      const limiter = await create();
      const results = [];
      for (let i = 0; i < 3; i++) results.push(await limiter.check("k", config));
      expect(results.map((r) => r.allowed)).toEqual([true, true, true]);
      expect(results.map((r) => r.remaining)).toEqual([2, 1, 0]);
    });

    it("blocks requests over the limit", async () => {
      const limiter = await create();
      for (let i = 0; i < 3; i++) await limiter.check("k", config);
      const blocked = await limiter.check("k", config);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
    });

    it("tracks keys independently", async () => {
      const limiter = await create();
      for (let i = 0; i < 4; i++) await limiter.check("a", config);
      expect((await limiter.check("a", config)).allowed).toBe(false);
      expect((await limiter.check("b", config)).allowed).toBe(true);
    });

    it("allows again after the window expires", async () => {
      const limiter = await create();
      const short = { maxRequests: 1, windowMs: 150 };
      expect((await limiter.check("k", short)).allowed).toBe(true);
      expect((await limiter.check("k", short)).allowed).toBe(false);
      await sleep(250);
      expect((await limiter.check("k", short)).allowed).toBe(true);
    });

    it("reports a resetAt inside the window", async () => {
      const limiter = await create();
      const before = Date.now();
      const result = await limiter.check("k", config);
      expect(result.resetAt).toBeGreaterThan(before);
      expect(result.resetAt).toBeLessThanOrEqual(Date.now() + config.windowMs + 50);
    });

    it("reset clears a key's counter", async () => {
      const limiter = await create();
      for (let i = 0; i < 4; i++) await limiter.check("k", config);
      expect((await limiter.check("k", config)).allowed).toBe(false);
      await limiter.reset("k");
      expect((await limiter.check("k", config)).allowed).toBe(true);
    });

    it("never over-admits under concurrent checks", async () => {
      const limiter = await create();
      const results = await Promise.all(Array.from({ length: 20 }, () => limiter.check("k", config)));
      expect(results.filter((r) => r.allowed)).toHaveLength(3);
    });
  });
}
