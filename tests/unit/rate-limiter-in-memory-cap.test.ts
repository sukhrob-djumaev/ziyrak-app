import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryRateLimiter } from "@/lib/rate-limiters/in-memory";

/**
 * The in-memory limiter keeps one entry per key and used to have no bound: a client that rotates
 * its (forwarded) address on every request could grow the map without limit. It is now capped;
 * when full, expired entries go first, then the oldest.
 */
const config = { maxRequests: 3, windowMs: 60_000 };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("InMemoryRateLimiter key cap", () => {
  it("never holds more than its cap of keys, however many distinct keys arrive", async () => {
    const limiter = new InMemoryRateLimiter(100);
    for (let i = 0; i < 1000; i++) await limiter.check(`ip:${i}`, config);
    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  it("still limits normally below the cap", async () => {
    const limiter = new InMemoryRateLimiter(100);
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await limiter.check("ip:steady", config)).allowed);
    expect(results).toEqual([true, true, true, false, false]);
  });

  it("drops expired entries before evicting live ones", async () => {
    const limiter = new InMemoryRateLimiter(50);
    for (let i = 0; i < 40; i++) await limiter.check(`old:${i}`, { maxRequests: 3, windowMs: 1_000 });
    vi.advanceTimersByTime(2_000); // those windows are over
    for (let i = 0; i < 40; i++) await limiter.check(`live:${i}`, config);
    expect(limiter.size).toBeLessThanOrEqual(50);
    // A live key's counter survived (the cap evicted expired entries, not these): exhaust one and see it blocked.
    for (let i = 0; i < 3; i++) await limiter.check("live:39", config);
    expect((await limiter.check("live:39", config)).allowed).toBe(false);
  });

  it("evicts the oldest entries when everything is live, and keeps the newest", async () => {
    const limiter = new InMemoryRateLimiter(10);
    for (let i = 0; i < 25; i++) await limiter.check(`k:${i}`, config);
    expect(limiter.size).toBe(10);
    for (let i = 0; i < 3; i++) await limiter.check("k:24", config);
    expect((await limiter.check("k:24", config)).allowed).toBe(false); // newest kept its counter
    expect((await limiter.check("k:0", config)).remaining).toBe(2); // oldest was evicted: a fresh window
  });

  it("does not sweep the whole map on every insertion while a flood keeps it full", async () => {
    const limiter = new InMemoryRateLimiter(1000);
    const forEach = vi.spyOn(Map.prototype, "entries");
    for (let i = 0; i < 1000; i++) await limiter.check(`fill:${i}`, config);
    const before = forEach.mock.calls.length;
    for (let i = 0; i < 2000; i++) await limiter.check(`flood:${i}`, config); // same instant: at most one sweep
    expect(forEach.mock.calls.length - before).toBeLessThanOrEqual(2);
    forEach.mockRestore();
  });

  it("clear() and reset() still work", async () => {
    const limiter = new InMemoryRateLimiter(10);
    await limiter.check("a", config);
    await limiter.reset("a");
    expect(limiter.size).toBe(0);
    await limiter.check("b", config);
    limiter.clear();
    expect(limiter.size).toBe(0);
  });
});
