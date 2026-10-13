import { describe, it, expect, afterEach, vi } from "vitest";
import type { RealtimeBus } from "@/lib/realtime/types";

export interface BusHarness {
  bus: RealtimeBus<{ n: number }>;
  /** Resolves once every subscribe() made so far is actually in effect (Redis subscribes asynchronously). */
  settled(): Promise<void>;
  close(): Promise<void>;
}

/** Poll until `fn` stops throwing (cross-process delivery is asynchronous). */
export async function eventually(fn: () => void, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      fn();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

export const quiet = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * PLAN.md §34.1/§46.8 — behavior every `RealtimeBus` must show identically
 * from a single replica's point of view (in-memory and Redis).
 */
export function describeRealtimeBusContract(name: string, create: () => Promise<BusHarness>, opts: { skip?: boolean } = {}) {
  describe.skipIf(opts.skip)(`RealtimeBus contract: ${name}`, () => {
    const open: BusHarness[] = [];
    const make = async () => {
      const harness = await create();
      open.push(harness);
      return harness;
    };
    afterEach(async () => {
      await Promise.all(open.splice(0).map((h) => h.close()));
    });

    it("delivers a published event to a subscriber on that channel", async () => {
      const { bus, settled } = await make();
      const cb = vi.fn();
      bus.subscribe("c1", cb);
      await settled();
      await bus.publish("c1", { n: 1 });
      await eventually(() => expect(cb).toHaveBeenCalledWith({ n: 1 }));
      await quiet();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("delivers to every subscriber of the channel", async () => {
      const { bus, settled } = await make();
      const a = vi.fn();
      const b = vi.fn();
      bus.subscribe("c1", a);
      bus.subscribe("c1", b);
      await settled();
      await bus.publish("c1", { n: 2 });
      await eventually(() => {
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
      });
    });

    it("does not deliver across channels", async () => {
      const { bus, settled } = await make();
      const other = vi.fn();
      bus.subscribe("c-other", other);
      await settled();
      await bus.publish("c1", { n: 3 });
      await quiet();
      expect(other).not.toHaveBeenCalled();
    });

    it("stops delivering after unsubscribe", async () => {
      const { bus, settled } = await make();
      const cb = vi.fn();
      const unsubscribe = bus.subscribe("c1", cb);
      await settled();
      unsubscribe();
      await settled();
      await bus.publish("c1", { n: 4 });
      await quiet();
      expect(cb).not.toHaveBeenCalled();
    });

    it("keeps delivering to the other subscribers when one callback throws", async () => {
      const { bus, settled } = await make();
      const good = vi.fn();
      bus.subscribe("c1", () => {
        throw new Error("subscriber failed");
      });
      bus.subscribe("c1", good);
      await settled();
      await bus.publish("c1", { n: 5 });
      await eventually(() => expect(good).toHaveBeenCalledTimes(1));
    });

    it("publish with no subscribers resolves without error", async () => {
      const { bus } = await make();
      await expect(bus.publish("nobody", { n: 6 })).resolves.toBeUndefined();
    });
  });
}
