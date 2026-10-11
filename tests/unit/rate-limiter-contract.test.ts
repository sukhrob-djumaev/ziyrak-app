import { randomUUID } from "node:crypto";
import { afterAll } from "vitest";
import { describeRateLimiterContract } from "../helpers/rate-limiter-contract";
import { InMemoryRateLimiter } from "@/lib/rate-limiters/in-memory";
import { RedisRateLimiter } from "@/lib/rate-limiters/redis";
import { createRedisClient } from "@/lib/redis/client";

describeRateLimiterContract("in-memory", () => new InMemoryRateLimiter());

// The Redis half needs a real Redis (REDIS_TEST_URL, or REDIS_URL as set for
// the "full suite with Redis selected" run). Skipped — which is not a pass —
// when neither is set.
const redisUrl = process.env.REDIS_TEST_URL ?? process.env.REDIS_URL;
const clients: ReturnType<typeof createRedisClient>[] = [];

describeRateLimiterContract(
  "redis",
  async () => {
    const client = createRedisClient(redisUrl!);
    await client.connect();
    clients.push(client);
    return new RedisRateLimiter(client, `rl-contract:${randomUUID()}:`);
  },
  { skip: !redisUrl }
);

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});
