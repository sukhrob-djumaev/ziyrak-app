import { describe, it, expect, vi, afterEach } from "vitest";
import { readBoundedBody, readBoundedJson, PayloadTooLargeError, BodyDeadlineError } from "@/lib/http/bounded-body";

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let i = 0;
  const pulled = { count: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled.count++;
      if (i < chunks.length) c.enqueue(chunks[i++]);
      else c.close();
    },
    cancel() {
      pulled.cancelled = true;
    },
  });
  const request = new Request("https://x.test/hook", { method: "POST", body, headers, duplex: "half" } as RequestInit);
  return { request, pulled };
}

afterEach(() => vi.useRealTimers());

describe("readBoundedBody (F06)", () => {
  it("reads a body within the limit", async () => {
    const { request } = streamed([Buffer.from("hel"), Buffer.from("lo")]);
    expect((await readBoundedBody(request, 10)).toString()).toBe("hello");
  });

  it("rejects an oversized declared Content-Length without reading", async () => {
    const { request, pulled } = streamed([Buffer.alloc(5)], { "content-length": "9999999" });
    await expect(readBoundedBody(request, 100)).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(pulled.count).toBeLessThanOrEqual(1);
  });

  it("stops a chunked body with no length as soon as the limit is crossed", async () => {
    const chunks = Array.from({ length: 1000 }, () => Buffer.alloc(1024, 1));
    const { request, pulled } = streamed(chunks);
    await expect(readBoundedBody(request, 4096)).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(pulled.count).toBeLessThan(20);
    expect(pulled.cancelled).toBe(true);
  });

  it("is not fooled by a Content-Length smaller than the real body", async () => {
    const { request } = streamed([Buffer.alloc(5000)], { "content-length": "10" });
    await expect(readBoundedBody(request, 100)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("times out a body that never finishes", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const request = new Request("https://x.test/hook", { method: "POST", body, duplex: "half" } as RequestInit);
    const p = readBoundedBody(request, 100, 500);
    const assertion = expect(p).rejects.toBeInstanceOf(BodyDeadlineError);
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
  });

  it("parses JSON and yields undefined for malformed input", async () => {
    expect(await readBoundedJson(streamed([Buffer.from('{"a":1}')]).request)).toEqual({ a: 1 });
    expect(await readBoundedJson(streamed([Buffer.from("{nope")]).request)).toBeUndefined();
  });
});
