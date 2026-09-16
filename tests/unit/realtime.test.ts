import { describe, it, expect, vi, beforeEach } from "vitest";

// Use actual realtime module (not mocked) for unit tests
vi.unmock("@/lib/realtime");

describe("Real-time Event System", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("should subscribe and receive published events", async () => {
    const { subscribe, publish } = await import("@/lib/realtime");
    const callback = vi.fn();

    const unsubscribe = subscribe("test-channel", callback);
    publish("test-channel", { type: "message:new", data: { id: "msg-1" } });

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ type: "message:new", data: { id: "msg-1" } })
    );

    unsubscribe();
  });

  it("should not receive events after unsubscribe", async () => {
    const { subscribe, publish } = await import("@/lib/realtime");
    const callback = vi.fn();

    const unsubscribe = subscribe("test-ch", callback);
    unsubscribe();
    publish("test-ch", { type: "message:new", data: {} });

    expect(callback).not.toHaveBeenCalled();
  });

  it("should publish to global channel as well", async () => {
    const { subscribe, publish } = await import("@/lib/realtime");
    const globalCb = vi.fn();

    const unsub = subscribe("global", globalCb);
    publish("specific-channel", { type: "conversation:new", data: {} });

    expect(globalCb).toHaveBeenCalledWith(
      expect.objectContaining({ type: "conversation:new" })
    );

    unsub();
  });

  it("should include timestamp in events", async () => {
    const { subscribe, publish } = await import("@/lib/realtime");
    const callback = vi.fn();

    const unsub = subscribe("ts-test", callback);
    publish("ts-test", { type: "notification", data: {} });

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: expect.any(String) })
    );

    unsub();
  });

  it("should track subscriber count", async () => {
    const { subscribe, getSubscriberCount } = await import("@/lib/realtime");

    const unsub1 = subscribe("ch1", vi.fn());
    const unsub2 = subscribe("ch2", vi.fn());

    expect(getSubscriberCount()).toBeGreaterThanOrEqual(2);

    unsub1();
    unsub2();
  });
});
