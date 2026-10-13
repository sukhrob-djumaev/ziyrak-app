import { afterAll, describe, expect, it, vi } from "vitest";
import { cacheDel, cacheGet, cacheSet, isCacheDistributed } from "@/lib/cache";
import { closeSharedRedis } from "@/lib/redis/client";

const redisUrl = process.env.REDIS_URL;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("cache (selected backend)", () => {
  afterAll(async () => {
    await closeSharedRedis();
  });

  it("reports whether the selected backend is distributed", async () => {
    expect(await isCacheDistributed()).toBe(Boolean(redisUrl));
  });

  it("round-trips a value and deletes it", async () => {
    await cacheSet("unit:a", "1");
    expect(await cacheGet("unit:a")).toBe("1");
    await cacheDel("unit:a");
    expect(await cacheGet("unit:a")).toBeNull();
  });

  it("expires a value after its TTL", async () => {
    vi.useRealTimers();
    await cacheSet("unit:ttl", "x", 1);
    expect(await cacheGet("unit:ttl")).toBe("x");
    await sleep(1200);
    expect(await cacheGet("unit:ttl")).toBeNull();
  });

  it("returns null for a missing key", async () => {
    expect(await cacheGet("unit:never-set")).toBeNull();
  });
});

// The "Redis is actually shared" half needs a real Redis; a skip is not a pass.
describe.skipIf(!redisUrl)("cache across replicas (redis)", () => {
  it("a value written by one process-wide client is visible to an independent client", async () => {
    const { createRedisClient, redisKeyPrefix } = await import("@/lib/redis/client");
    await cacheSet("unit:shared", "from-replica-a");
    const other = createRedisClient(redisUrl!);
    await other.connect();
    try {
      expect(await other.get(`${redisKeyPrefix()}cache:unit:shared`)).toBe("from-replica-a");
    } finally {
      await other.close();
      await cacheDel("unit:shared");
    }
  });
});

describe("cache falls back when Redis is unreachable", () => {
  it("serves from memory instead of throwing", async () => {
    vi.resetModules();
    const previous = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:1"; // nothing listens here
    try {
      const mod = await import("@/lib/cache");
      await mod.cacheSet("unit:down", "ok");
      expect(await mod.cacheGet("unit:down")).toBe("ok");
      expect(await mod.isCacheDistributed()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previous;
    }
  });
});
