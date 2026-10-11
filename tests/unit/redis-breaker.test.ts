import { describe, expect, it } from "vitest";
import { COMMAND_TIMEOUT_MS, getSharedRedis, redisCall } from "@/lib/redis/client";

const redisUrl = process.env.REDIS_URL;

describe("redisCall", () => {
  it("rejects a command that exceeds its budget instead of hanging the caller", async () => {
    const started = Date.now();
    await expect(redisCall(() => new Promise<never>(() => {}))).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(COMMAND_TIMEOUT_MS + 500);
  });

  it.skipIf(!redisUrl)("after a timeout, callers get no client (in-memory fallback) until the breaker window passes", async () => {
    await expect(redisCall(() => new Promise<never>(() => {}))).rejects.toThrow();
    expect(await getSharedRedis()).toBeNull();
  });

  it("passes a fast command's result through", async () => {
    await expect(redisCall(async () => 7)).resolves.toBe(7);
  });
});
