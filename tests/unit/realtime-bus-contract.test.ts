import { randomUUID } from "node:crypto";
import { describeRealtimeBusContract } from "../helpers/realtime-bus-contract";
import { InMemoryRealtimeBus } from "@/lib/realtime/in-memory-bus";
import { RedisRealtimeBus } from "@/lib/realtime/redis-bus";

describeRealtimeBusContract("in-memory", async () => {
  const bus = new InMemoryRealtimeBus<{ n: number }>();
  return { bus, settled: async () => {}, close: async () => {} };
});

// Needs a real Redis (REDIS_TEST_URL, or REDIS_URL for the full-suite run).
// A skip is not a pass.
const redisUrl = process.env.REDIS_TEST_URL ?? process.env.REDIS_URL;

describeRealtimeBusContract(
  "redis",
  async () => {
    const bus = new RedisRealtimeBus<{ n: number }>({ url: redisUrl!, prefix: `rt-contract:${randomUUID()}:` });
    return { bus, settled: () => bus.settled(), close: () => bus.close() };
  },
  { skip: !redisUrl }
);
