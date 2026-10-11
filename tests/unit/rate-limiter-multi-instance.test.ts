import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisRateLimiter } from "@/lib/rate-limiters/redis";
import { InMemoryRateLimiter } from "@/lib/rate-limiters/in-memory";
import { createRedisClient } from "@/lib/redis/client";

const redisUrl = process.env.REDIS_TEST_URL ?? process.env.REDIS_URL;

/**
 * PLAN.md §46.8 acceptance — "a test issuing requests split across two
 * replica instances and confirming the shared limit, not limit × replicas,
 * is enforced". Each "replica" is its own limiter on its own Redis
 * connection; the in-memory pair documents the exact failure being fixed.
 */
describe("rate limit across replicas", () => {
  const config = { maxRequests: 10, windowMs: 5000 };

  it("in-memory limiters multiply the limit by the replica count (the bug Redis fixes)", async () => {
    const a = new InMemoryRateLimiter();
    const b = new InMemoryRateLimiter();
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? a : b).check("client", config))
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(20);
  });

  describe.skipIf(!redisUrl)("redis", () => {
    const clients: ReturnType<typeof createRedisClient>[] = [];
    let replicaA: RedisRateLimiter;
    let replicaB: RedisRateLimiter;

    beforeAll(async () => {
      const prefix = `rl-multi:${randomUUID()}:`;
      for (let i = 0; i < 2; i++) {
        const client = createRedisClient(redisUrl!);
        await client.connect();
        clients.push(client);
      }
      replicaA = new RedisRateLimiter(clients[0], prefix);
      replicaB = new RedisRateLimiter(clients[1], prefix);
    });

    afterAll(async () => {
      await Promise.all(clients.map((c) => c.close()));
    });

    it("enforces the shared limit, not limit × replicas, for requests split across two replicas", async () => {
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? replicaA : replicaB).check("client", config))
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(config.maxRequests);
      expect(results.filter((r) => !r.allowed)).toHaveLength(20);
    });

    it("a window opened by one replica is honored by the other", async () => {
      const short = { maxRequests: 1, windowMs: 200 };
      expect((await replicaA.check("w", short)).allowed).toBe(true);
      expect((await replicaB.check("w", short)).allowed).toBe(false);
      await new Promise((r) => setTimeout(r, 300));
      expect((await replicaB.check("w", short)).allowed).toBe(true);
    });
  });
});
