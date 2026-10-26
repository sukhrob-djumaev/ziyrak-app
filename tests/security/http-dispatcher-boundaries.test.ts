import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { dispatchHttpRequest, SSRFBlockedError } from "@/lib/integrations/http-dispatcher";

/**
 * L1.2 / F02 + F10: credential protection across redirects and whole-operation
 * deadlines/body bounds for the shared outbound dispatcher. Like the SSRF suite,
 * this uses a scripted fake transport and mocked DNS — no real socket or host.
 */

let mockedLookup: ReturnType<typeof vi.spyOn>;

type Hop = { status: number; headers?: Record<string, string> };
interface Seen {
  protocol: string;
  hostname: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeRes(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new EventEmitter(), {
    statusCode: status,
    statusMessage: status === 200 ? "OK" : "Redirect",
    headers,
    resume: vi.fn(),
    destroy: vi.fn(),
  });
}

/** Scripts one response per hop on whichever of http/https the hop uses; records what was sent. */
function script(hops: Hop[]) {
  const seen: Seen[] = [];
  let i = 0;
  const impl = (proto: string) =>
    ((options: Record<string, unknown>, callback: (res: unknown) => void) => {
      const hop = hops[Math.min(i++, hops.length - 1)];
      const entry: Seen = {
        protocol: proto,
        hostname: String(options.hostname),
        method: String(options.method),
        headers: { ...((options.headers as Record<string, string>) ?? {}) },
      };
      seen.push(entry);
      const req = Object.assign(new EventEmitter(), {
        write: (b: string) => void (entry.body = b),
        end: () => {
          const res = fakeRes(hop.status, hop.headers);
          callback(res);
          queueMicrotask(() => res.emit("end"));
        },
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      });
      return req;
    }) as never;
  vi.spyOn(http, "request").mockImplementation(impl("http:"));
  vi.spyOn(https, "request").mockImplementation(impl("https:"));
  return seen;
}

const publicIp = (host: string) => [{ address: host.startsWith("b") ? "93.184.216.35" : "93.184.216.34", family: 4 }];

beforeEach(() => {
  mockedLookup = vi.spyOn(dns.promises, "lookup");
  mockedLookup.mockImplementation((async (h: string) => publicIp(h)) as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const secret = { Authorization: "Bearer s3cret", "X-Api-Key": "k-123", Cookie: "sid=1", "Content-Type": "application/json" };

describe("redirect credential protection (F02)", () => {
  it("strips caller credentials when a 301/302/303 leaves the origin", async () => {
    for (const status of [301, 302, 303]) {
      const seen = script([{ status, headers: { location: "https://b.example.test/next" } }, { status: 200 }]);
      await dispatchHttpRequest("https://a.example.test/hook", { method: "POST", body: "{}", headers: secret });
      expect(seen).toHaveLength(2);
      expect(seen[0].headers.Authorization).toBe("Bearer s3cret");
      expect(Object.keys(seen[1].headers).map((k) => k.toLowerCase())).not.toEqual(
        expect.arrayContaining(["authorization"])
      );
      for (const k of Object.keys(seen[1].headers)) expect(k.toLowerCase()).toMatch(/^(content-type|accept|user-agent)$/);
      expect(seen[1].method).toBe("GET");
      expect(seen[1].body).toBeUndefined();
      vi.restoreAllMocks();
      mockedLookup = vi.spyOn(dns.promises, "lookup");
      mockedLookup.mockImplementation((async (h: string) => publicIp(h)) as never);
    }
  });

  it("refuses a cross-origin 307/308 that would replay the method, body and headers elsewhere", async () => {
    for (const status of [307, 308]) {
      const seen = script([{ status, headers: { location: "https://b.example.test/next" } }, { status: 200 }]);
      await expect(
        dispatchHttpRequest("https://a.example.test/hook", { method: "POST", body: "{}", headers: secret })
      ).rejects.toBeInstanceOf(SSRFBlockedError);
      expect(seen).toHaveLength(1);
    }
  });

  it("rejects an HTTPS to HTTP downgrade, including to the same host", async () => {
    const seen = script([{ status: 302, headers: { location: "http://a.example.test/plain" } }, { status: 200 }]);
    await expect(
      dispatchHttpRequest("https://a.example.test/hook", { method: "POST", body: "{}", headers: secret })
    ).rejects.toThrow(/downgrade/i);
    expect(seen).toHaveLength(1);
  });

  it("keeps headers and method on a same-origin 307", async () => {
    const seen = script([{ status: 307, headers: { location: "/moved" } }, { status: 200 }]);
    await dispatchHttpRequest("https://a.example.test/hook", { method: "POST", body: "{}", headers: secret });
    expect(seen[1].headers.Authorization).toBe("Bearer s3cret");
    expect(seen[1].method).toBe("POST");
    expect(seen[1].body).toBe("{}");
  });

  it("treats a different port or scheme as a different origin", async () => {
    const seen = script([{ status: 302, headers: { location: "https://a.example.test:8443/x" } }, { status: 200 }]);
    await dispatchHttpRequest("https://a.example.test/hook", { method: "POST", body: "{}", headers: secret });
    expect(seen[1].headers.Authorization).toBeUndefined();
  });
});

describe("whole-operation deadline and bounded bodies (F10)", () => {
  it("applies the deadline to DNS resolution", async () => {
    vi.useFakeTimers();
    mockedLookup.mockImplementation((() => new Promise(() => {})) as never);
    const p = dispatchHttpRequest("https://a.example.test/hook", { timeoutMs: 1000 });
    const assertion = expect(p).rejects.toThrow(/timed out|deadline/i);
    await vi.advanceTimersByTimeAsync(1100);
    await assertion;
  });

  it("terminates a response that keeps dripping past the overall deadline", async () => {
    vi.useFakeTimers();
    const res = fakeRes(200);
    vi.spyOn(https, "request").mockImplementation(((_o: unknown, cb: (r: unknown) => void) => {
      const req = Object.assign(new EventEmitter(), { write: vi.fn(), setTimeout: vi.fn(), destroy: vi.fn() });
      (req as { end: () => void }).end = () => {
        cb(res);
        const t = setInterval(() => res.emit("data", Buffer.from("x")), 200);
        res.once("close", () => clearInterval(t));
        res.destroy.mockImplementation(() => {
          clearInterval(t);
          res.emit("close");
        });
      };
      req.destroy.mockImplementation((e?: Error) => {
        if (e) req.emit("error", e);
        res.destroy();
      });
      return req;
    }) as never);
    const p = dispatchHttpRequest("https://a.example.test/hook", { timeoutMs: 1000, includeResponseBody: true });
    const assertion = expect(p).rejects.toThrow(/timed out|deadline/i);
    await vi.advanceTimersByTimeAsync(1500);
    await assertion;
  });

  it("shares one deadline across redirect hops", async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.spyOn(https, "request").mockImplementation(((_o: unknown, cb: (r: unknown) => void) => {
      const hop = n++;
      const req = Object.assign(new EventEmitter(), { write: vi.fn(), setTimeout: vi.fn(), destroy: vi.fn() });
      (req as { end: () => void }).end = () => {
        // Each hop answers after 600 ms; with a 1000 ms total the second must not get a fresh 1000 ms.
        setTimeout(() => {
          const res = fakeRes(hop < 3 ? 302 : 200, hop < 3 ? { location: `/h${hop + 1}` } : {});
          cb(res);
          queueMicrotask(() => res.emit("end"));
        }, 600);
      };
      req.destroy.mockImplementation((e?: Error) => e && req.emit("error", e));
      return req;
    }) as never);
    const p = dispatchHttpRequest("https://a.example.test/hook", { timeoutMs: 1000 });
    const assertion = expect(p).rejects.toThrow(/timed out|deadline/i);
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(n).toBeLessThan(4);
  });

  it("stops reading a captured body at the cap instead of draining the rest", async () => {
    const res = fakeRes(200);
    vi.spyOn(https, "request").mockImplementation(((_o: unknown, cb: (r: unknown) => void) => {
      const req = Object.assign(new EventEmitter(), { write: vi.fn(), setTimeout: vi.fn(), destroy: vi.fn() });
      (req as { end: () => void }).end = () => {
        cb(res);
        res.emit("data", Buffer.alloc(1_000_000, 97));
        res.emit("data", Buffer.alloc(10, 98));
        queueMicrotask(() => res.emit("end"));
      };
      return req;
    }) as never);
    const out = await dispatchHttpRequest("https://a.example.test/hook", { includeResponseBody: true });
    expect(out.body).toHaveLength(1_000_000);
    expect(res.destroy).toHaveBeenCalled();
  });

  it("does not drain an unbounded body when only the status is wanted", async () => {
    const res = fakeRes(200);
    vi.spyOn(https, "request").mockImplementation(((_o: unknown, cb: (r: unknown) => void) => {
      const req = Object.assign(new EventEmitter(), { write: vi.fn(), setTimeout: vi.fn(), destroy: vi.fn() });
      (req as { end: () => void }).end = () => {
        cb(res);
        res.emit("data", Buffer.alloc(1_000_001, 97));
        queueMicrotask(() => res.emit("end"));
      };
      return req;
    }) as never);
    const out = await dispatchHttpRequest("https://a.example.test/hook");
    expect(out.status).toBe(200);
    expect(res.destroy).toHaveBeenCalled();
  });
});

describe("request construction failures", () => {
  it("rejects once and leaves no armed timer when the transport throws synchronously (invalid header name)", async () => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    mockedLookup = vi.spyOn(dns.promises, "lookup");
    mockedLookup.mockImplementation((async (h: string) => publicIp(h)) as never);
    const real = https.request;
    expect(real).toBeTypeOf("function"); // real transport validates header names itself
    await expect(
      dispatchHttpRequest("https://a.example.test/hook", { headers: { "X Bad": "1" }, timeoutMs: 1000 })
    ).rejects.toThrow(/header/i);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000); // must not throw an uncaught ReferenceError
  });
});
