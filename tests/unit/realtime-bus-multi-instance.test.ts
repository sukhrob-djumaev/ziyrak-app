import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedisRealtimeBus } from "@/lib/realtime/redis-bus";
import { InMemoryRealtimeBus } from "@/lib/realtime/in-memory-bus";
import { eventually, quiet } from "../helpers/realtime-bus-contract";

const redisUrl = process.env.REDIS_TEST_URL ?? process.env.REDIS_URL;

/**
 * PLAN.md §46.8 — "realtime notification delivery across replicas". Each
 * RedisRealtimeBus is one replica with its own connections; the in-memory
 * pair documents the silent miss being fixed.
 */
describe("realtime across replicas", () => {
  it("in-memory buses on two replicas do not see each other's events (the gap Redis closes)", async () => {
    const a = new InMemoryRealtimeBus<{ n: number }>();
    const b = new InMemoryRealtimeBus<{ n: number }>();
    const onB = vi.fn();
    b.subscribe("c", onB);
    await a.publish("c", { n: 1 });
    expect(onB).not.toHaveBeenCalled();
  });

  describe.skipIf(!redisUrl)("redis", () => {
    let prefix: string;
    let a: RedisRealtimeBus<{ n: number }>;
    let b: RedisRealtimeBus<{ n: number }>;

    beforeEach(() => {
      prefix = `rt-multi:${randomUUID()}:`;
      a = new RedisRealtimeBus({ url: redisUrl!, prefix });
      b = new RedisRealtimeBus({ url: redisUrl!, prefix });
    });
    afterEach(async () => {
      await Promise.all([a.close(), b.close()]);
    });

    it("an event published on replica A reaches a subscriber on replica B exactly once", async () => {
      const onB = vi.fn();
      b.subscribe("c", onB);
      await b.settled();
      await a.publish("c", { n: 1 });
      await eventually(() => expect(onB).toHaveBeenCalledWith({ n: 1 }));
      await quiet();
      expect(onB).toHaveBeenCalledTimes(1);
    });

    it("the publishing replica's own subscribers get the event exactly once (no echo from Redis)", async () => {
      const onA = vi.fn();
      const onB = vi.fn();
      a.subscribe("c", onA);
      b.subscribe("c", onB);
      await Promise.all([a.settled(), b.settled()]);
      await a.publish("c", { n: 2 });
      await eventually(() => expect(onB).toHaveBeenCalledTimes(1));
      await quiet();
      expect(onA).toHaveBeenCalledTimes(1);
      expect(onB).toHaveBeenCalledTimes(1);
    });

    it("a replica with no subscriber on the channel is not delivered to, and channels stay separate", async () => {
      const other = vi.fn();
      b.subscribe("other", other);
      await b.settled();
      await a.publish("c", { n: 3 });
      await quiet();
      expect(other).not.toHaveBeenCalled();
    });

    it("keeps working after the last subscriber leaves and a new one joins", async () => {
      const first = vi.fn();
      const unsubscribe = b.subscribe("c", first);
      await b.settled();
      unsubscribe();
      await b.settled();
      const second = vi.fn();
      b.subscribe("c", second);
      await b.settled();
      await a.publish("c", { n: 4 });
      await eventually(() => expect(second).toHaveBeenCalledTimes(1));
      expect(first).not.toHaveBeenCalled();
    });
  });
});
