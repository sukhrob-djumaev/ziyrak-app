import { describe, expect, it, vi } from "vitest";
import { authorizedEventStream } from "@/lib/realtime/authorized-stream";
import type { EventPayload } from "@/lib/realtime/realtime";
const event: EventPayload = {
  type: "message:new",
  conversationId: "controlled",
  data: { content: "private pending frame" },
  timestamp: new Date().toISOString(),
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function next(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const result = await reader.read();
  return { done: result.done, text: new TextDecoder().decode(result.value) };
}
function setup(
  refresh: () => Promise<{ id: string } | null>,
  project: (authority: { id: string }, e: EventPayload) => Promise<EventPayload | null>
) {
  const abort = new AbortController(),
    stop = vi.fn();
  let emit!: (e: EventPayload) => void;
  const stream = authorizedEventStream({
    signal: abort.signal,
    connected: { type: "connected" },
    subscribe: (callback) => {
      emit = callback;
      return stop;
    },
    refresh,
    project,
  });
  return { abort, stop, emit, reader: stream.getReader() };
}
describe("ordered stream cancellation and failed admission", () => {
  it("abort during a persistence lookup invalidates pending output and unsubscribes", async () => {
    const entered = deferred<void>(),
      hold = deferred<EventPayload | null>();
    const s = setup(
      async () => ({ id: "current" }),
      async () => {
        entered.resolve();
        return hold.promise;
      }
    );
    await next(s.reader);
    s.emit(event);
    await entered.promise;
    s.abort.abort();
    hold.resolve(event);
    expect(await next(s.reader)).toEqual({ done: true, text: "" });
    expect(s.stop).toHaveBeenCalledOnce();
  });
  it("reader cancellation cleans timer and subscription without waiting for a stuck lookup", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const entered = deferred<void>(),
      hold = deferred<{ id: string } | null>();
    try {
      const project = vi.fn(async () => event),
        s = setup(async () => {
          entered.resolve();
          return hold.promise;
        }, project);
      await next(s.reader);
      s.emit(event);
      await entered.promise;
      await s.reader.cancel();
      expect(s.stop).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      hold.resolve({ id: "current" });
      await Promise.resolve();
      expect(project).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("a failed authority lookup closes instead of publishing cached content", async () => {
    const s = setup(
      async () => {
        throw Error("controlled database unavailable");
      },
      async () => event
    );
    await next(s.reader);
    s.emit(event);
    const ended = await next(s.reader);
    expect(ended.text).toContain("session_ended");
    expect(ended.text).not.toContain("private");
    expect((await next(s.reader)).done).toBe(true);
    expect(s.stop).toHaveBeenCalledOnce();
  });
  it("bounds pending frames while a lookup is stalled", async () => {
    const hold = deferred<{ id: string } | null>();
    const s = setup(
      () => hold.promise,
      async () => event
    );
    await next(s.reader);
    for (let n = 0; n < 101; n++) s.emit(event);
    const ended = await next(s.reader);
    expect(ended.text).toContain("session_ended");
    expect((await next(s.reader)).done).toBe(true);
    hold.resolve({ id: "current" });
    expect(s.stop).toHaveBeenCalledOnce();
  });
});
