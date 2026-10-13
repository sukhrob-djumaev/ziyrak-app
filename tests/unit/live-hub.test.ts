import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LiveEventHub, parseLiveEvent, shouldRefreshOn, type SourceLike, type LiveEvent } from "@/lib/live/hub";

class FakeSource implements SourceLike {
  static instances: FakeSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readyState = 1; // OPEN
  closed = false;
  constructor() { FakeSource.instances.push(this); }
  close() { this.closed = true; this.readyState = 2; }
  emit(payload: unknown) { this.onmessage?.({ data: typeof payload === "string" ? payload : JSON.stringify(payload) }); }
}

describe("parseLiveEvent / shouldRefreshOn", () => {
  it("parses event JSON and rejects anything else", () => {
    expect(parseLiveEvent('{"type":"message:new","conversationId":"c1","data":{"role":"customer"}}')).toMatchObject({ type: "message:new", conversationId: "c1" });
    expect(parseLiveEvent("not json")).toBeNull();
    expect(parseLiveEvent('{"no":"type"}')).toBeNull();
    expect(parseLiveEvent('"just a string"')).toBeNull();
    expect(parseLiveEvent('{"type":42}')).toBeNull();
  });
  it("refreshes on changes that alter what a person sees, not on connection chatter or typing", () => {
    for (const type of ["message:new", "conversation:new", "conversation:updated", "conversation:assigned", "ticket:new", "ticket:updated", "notification"]) {
      expect(shouldRefreshOn({ type })).toBe(true);
    }
    for (const type of ["connected", "typing:start", "typing:stop", "agent:online", "whatever"]) expect(shouldRefreshOn({ type })).toBe(false);
  });
});

describe("LiveEventHub", () => {
  beforeEach(() => { FakeSource.instances = []; vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  const make = (onSessionEnded = vi.fn()) => ({ hub: new LiveEventHub(() => new FakeSource(), onSessionEnded), onSessionEnded });

  it("opens one connection for any number of subscribers and closes it with the last one", () => {
    const { hub } = make();
    const stopA = hub.subscribe(() => {});
    const stopB = hub.subscribe(() => {});
    expect(FakeSource.instances).toHaveLength(1);
    stopA();
    expect(FakeSource.instances[0].closed).toBe(false);
    stopB();
    expect(FakeSource.instances[0].closed).toBe(true);
    hub.subscribe(() => {}); // a later subscriber reconnects
    expect(FakeSource.instances).toHaveLength(2);
  });

  it("delivers each event to every subscriber, skipping the connection greeting and malformed frames", () => {
    const { hub } = make();
    const a: LiveEvent[] = [];
    const b: LiveEvent[] = [];
    hub.subscribe((e) => a.push(e));
    hub.subscribe((e) => b.push(e));
    const source = FakeSource.instances[0];
    source.emit({ type: "connected", channel: "global" });
    source.emit("garbage");
    source.emit({ type: "message:new", conversationId: "c1", data: {} });
    expect(a.map((e) => e.type)).toEqual(["message:new"]);
    expect(b.map((e) => e.type)).toEqual(["message:new"]);
  });

  it("a subscriber that throws does not stop the others", () => {
    const { hub } = make();
    const seen: string[] = [];
    hub.subscribe(() => { throw new Error("boom"); });
    hub.subscribe((e) => seen.push(e.type));
    FakeSource.instances[0].emit({ type: "notification", data: {} });
    expect(seen).toEqual(["notification"]);
  });

  it("session_ended closes the stream, tells the app, and does not reconnect", () => {
    const { hub, onSessionEnded } = make();
    hub.subscribe(() => {});
    FakeSource.instances[0].emit({ type: "session_ended" });
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect(FakeSource.instances[0].closed).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(FakeSource.instances).toHaveLength(1);
  });

  it("reopens after the browser gives up on the connection, backing off, while someone is still listening", () => {
    const { hub } = make();
    hub.subscribe(() => {});
    const first = FakeSource.instances[0];
    first.readyState = 2; // CLOSED: not retrying by itself
    first.onerror?.({});
    expect(FakeSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    expect(FakeSource.instances).toHaveLength(2);
    FakeSource.instances[1].readyState = 2;
    FakeSource.instances[1].onerror?.({});
    vi.advanceTimersByTime(5_000);
    expect(FakeSource.instances).toHaveLength(2); // second wait is longer
    vi.advanceTimersByTime(5_000);
    expect(FakeSource.instances).toHaveLength(3);
  });

  it("does not reopen once everyone has unsubscribed", () => {
    const { hub } = make();
    const stop = hub.subscribe(() => {});
    FakeSource.instances[0].readyState = 2;
    FakeSource.instances[0].onerror?.({});
    stop();
    vi.advanceTimersByTime(120_000);
    expect(FakeSource.instances).toHaveLength(1);
  });

  it("leaves a still-connecting browser retry alone (readyState CONNECTING)", () => {
    const { hub } = make();
    hub.subscribe(() => {});
    FakeSource.instances[0].readyState = 0;
    FakeSource.instances[0].onerror?.({});
    vi.advanceTimersByTime(120_000);
    expect(FakeSource.instances).toHaveLength(1);
  });
});
