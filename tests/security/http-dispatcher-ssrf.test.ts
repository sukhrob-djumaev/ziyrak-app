import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * PLAN.md §32.1/§33.4 item 7/§46.6 — the shared SSRF-hardened dispatcher
 * used by `trigger_webhook` (PR1) and `webhook-delivery.ts` (PR2). Per §35,
 * this suite never touches a real external host or a real listening
 * socket: `node:dns`'s `lookup` and `node:http`/`node:https`'s `request`
 * are both mocked so the test controls DNS resolution and transport
 * behavior directly, deterministically, with zero network I/O — the local,
 * in-process "server" here is a fully scripted fake transport, not a real
 * bound socket, which is what lets an "allowed URL succeeds" case be
 * proven without ever needing a real reachable public host (impossible to
 * get right anyway: any locally-reachable test server necessarily lives at
 * a loopback/private address, which a correct SSRF dispatcher must always
 * refuse — there is no address a local test server can bind to that is
 * both reachable and legitimately "public").
 */

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import {
  dispatchHttpRequest,
  isDisallowedAddress,
  SSRFBlockedError,
} from "@/lib/integrations/http-dispatcher";

// `vi.spyOn` (not `vi.mock`) — it patches `dns.promises.lookup` in place on
// the real, live module object, so the dispatcher's own internal call to
// it (inside the same module, `resolveHostname`/`resolveAndValidate`) sees
// the patched version too. A full `vi.mock("node:dns", ...)` replaces the
// module binding only for *other* modules' `import`s of it, never for
// calls made from within the mocked module's own source — it would not
// intercept the dispatcher's own internal resolution at all.
let mockedLookup: ReturnType<typeof vi.spyOn>;

function fakeIncomingMessage(status: number, headers: Record<string, string> = {}) {
  const res = Object.assign(new EventEmitter(), {
    statusCode: status,
    statusMessage: status === 200 ? "OK" : "Redirect",
    headers,
    resume: vi.fn(),
  });
  return res;
}

/** Installs a scripted fake transport.request() that never opens a real socket. */
function mockTransportOnce(status: number, headers: Record<string, string> = {}) {
  const requestSpy = vi.fn().mockImplementation((_options: unknown, callback: (res: unknown) => void) => {
    const req = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
    req.end = vi.fn(() => {
      const res = fakeIncomingMessage(status, headers);
      callback(res);
      queueMicrotask(() => res.emit("end"));
    });
    return req;
  });
  return requestSpy;
}

beforeEach(() => {
  mockedLookup = vi.spyOn(dns.promises, "lookup");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isDisallowedAddress — pure range checks (§32.1)", () => {
  it.each([
    ["127.0.0.1", 4, "loopback"],
    ["10.1.2.3", 4, "RFC1918 10.0.0.0/8"],
    ["172.16.5.5", 4, "RFC1918 172.16.0.0/12"],
    ["192.168.1.1", 4, "RFC1918 192.168.0.0/16"],
    ["169.254.169.254", 4, "link-local / cloud metadata endpoint"],
    ["169.254.1.1", 4, "link-local"],
    ["0.0.0.0", 4, "this-network"],
  ])("blocks IPv4 %s (%s)", (address, family) => {
    expect(isDisallowedAddress(address, family)).toBe(true);
  });

  it.each([
    ["8.8.8.8", 4],
    ["93.184.216.34", 4],
    ["1.1.1.1", 4],
  ])("allows real public IPv4 %s", (address, family) => {
    expect(isDisallowedAddress(address, family)).toBe(false);
  });

  it.each([
    ["::1", 6, "loopback"],
    ["fe80::1", 6, "link-local"],
    ["fc00::1234", 6, "unique local"],
    ["fd12:3456::1", 6, "unique local"],
    ["::ffff:127.0.0.1", 6, "IPv4-mapped loopback"],
    ["::ffff:169.254.169.254", 6, "IPv4-mapped metadata endpoint"],
    ["::ffff:10.0.0.5", 6, "IPv4-mapped RFC1918"],
  ])("blocks IPv6 %s (%s)", (address, family) => {
    expect(isDisallowedAddress(address, family)).toBe(true);
  });

  it("allows a real public IPv6 address, including IPv4-mapped public addresses", () => {
    expect(isDisallowedAddress("2001:4860:4860::8888", 6)).toBe(false);
    expect(isDisallowedAddress("::ffff:8.8.8.8", 6)).toBe(false);
  });
});

describe("dispatchHttpRequest — resolution + connection (§32.1/§33.4 item 7)", () => {
  it("rejects a hostname that resolves to a private/RFC1918 address, before any connection is attempted", async () => {
    mockedLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }] as never);
    const httpSpy = mockTransportOnce(200);
    vi.spyOn(http, "request").mockImplementation(httpSpy);

    await expect(dispatchHttpRequest("http://internal.test/hook")).rejects.toThrow(SSRFBlockedError);
    expect(httpSpy).not.toHaveBeenCalled();
  });

  it("rejects a hostname resolving to the cloud metadata endpoint (169.254.169.254)", async () => {
    mockedLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }] as never);
    const httpSpy = mockTransportOnce(200);
    vi.spyOn(http, "request").mockImplementation(httpSpy);

    await expect(dispatchHttpRequest("http://metadata.test/latest/meta-data/")).rejects.toThrow(SSRFBlockedError);
    expect(httpSpy).not.toHaveBeenCalled();
  });

  it("rejects a hostname resolving to an IPv6 loopback/link-local/ULA address", async () => {
    mockedLookup.mockResolvedValue([{ address: "fe80::1", family: 6 }] as never);
    const httpSpy = mockTransportOnce(200);
    vi.spyOn(http, "request").mockImplementation(httpSpy);

    await expect(dispatchHttpRequest("http://v6-internal.test/")).rejects.toThrow(SSRFBlockedError);
    expect(httpSpy).not.toHaveBeenCalled();
  });

  it("rejects when even one of several resolved addresses is disallowed", async () => {
    mockedLookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ] as never);
    const httpSpy = mockTransportOnce(200);
    vi.spyOn(http, "request").mockImplementation(httpSpy);

    await expect(dispatchHttpRequest("http://multi-a-record.test/")).rejects.toThrow(SSRFBlockedError);
    expect(httpSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-http(s) protocol outright", async () => {
    await expect(dispatchHttpRequest("file:///etc/passwd")).rejects.toThrow(SSRFBlockedError);
  });

  it("proceeds to a real connection attempt when the resolved address is a public one", async () => {
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    const httpsSpy = mockTransportOnce(200);
    vi.spyOn(https, "request").mockImplementation(httpsSpy);

    const result = await dispatchHttpRequest("https://safe.example.test/hook", { method: "POST", body: "{}" });

    expect(result).toEqual({ ok: true, status: 200, statusText: "OK" });
    expect(httpsSpy).toHaveBeenCalledTimes(1);
    const [options] = httpsSpy.mock.calls[0] as [{ hostname: string; lookup: unknown }, unknown];
    expect(options.hostname).toBe("safe.example.test"); // TLS SNI/Host stay on the real hostname, not the resolved IP
    expect(typeof options.lookup).toBe("function");
  });

  it("does not auto-follow a redirect to a disallowed address — rejected at the redirect hop, no second connection made", async () => {
    // First hop: safe.example.test resolves publicly and responds 302 to
    // a second hostname that resolves to a private address.
    mockedLookup.mockImplementation(async (hostname: unknown) => {
      if (hostname === "safe.example.test") return [{ address: "93.184.216.34", family: 4 }] as never;
      if (hostname === "internal.example.test") return [{ address: "192.168.1.1", family: 4 }] as never;
      throw new Error(`unexpected hostname in test: ${hostname}`);
    });

    let callCount = 0;
    const transportSpy = vi.fn().mockImplementation((_options: unknown, callback: (res: unknown) => void) => {
      callCount += 1;
      const req = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
      req.end = vi.fn(() => {
        const res = fakeIncomingMessage(302, { location: "http://internal.example.test/private" });
        callback(res);
        queueMicrotask(() => res.emit("end"));
      });
      return req;
    });
    vi.spyOn(http, "request").mockImplementation(transportSpy);

    await expect(dispatchHttpRequest("http://safe.example.test/start")).rejects.toThrow(SSRFBlockedError);
    // Exactly one real connection (the first, allowed hop) — the redirect
    // target is rejected during re-validation, before a second connection.
    expect(callCount).toBe(1);
  });

  it("follows a redirect to a safe address and returns that hop's result", async () => {
    mockedLookup.mockImplementation(async (hostname: unknown) => {
      if (hostname === "safe.example.test") return [{ address: "93.184.216.34", family: 4 }] as never;
      if (hostname === "also-safe.example.test") return [{ address: "93.184.216.35", family: 4 }] as never;
      throw new Error(`unexpected hostname in test: ${hostname}`);
    });

    let call = 0;
    vi.spyOn(http, "request").mockImplementation((_options: unknown, callback: (res: unknown) => void) => {
      call += 1;
      const req = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
      req.end = vi.fn(() => {
        const res =
          call === 1
            ? fakeIncomingMessage(301, { location: "http://also-safe.example.test/final" })
            : fakeIncomingMessage(200);
        callback(res);
        queueMicrotask(() => res.emit("end"));
      });
      return req;
    });

    const result = await dispatchHttpRequest("http://safe.example.test/start", { method: "POST", body: "{}" });
    expect(result).toEqual({ ok: true, status: 200, statusText: "OK" });
    expect(call).toBe(2);
  });

  it("re-validates on every call — a DNS answer that changes between two dispatches to the same URL is re-checked, not cached", async () => {
    mockedLookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never);
    vi.spyOn(http, "request").mockImplementation(mockTransportOnce(200));
    const first = await dispatchHttpRequest("http://rebinding.test/hook");
    expect(first.ok).toBe(true);

    // Simulates DNS rebinding: the same hostname now resolves internally.
    mockedLookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);
    const httpSpy = mockTransportOnce(200);
    vi.spyOn(http, "request").mockImplementation(httpSpy);

    await expect(dispatchHttpRequest("http://rebinding.test/hook")).rejects.toThrow(SSRFBlockedError);
    expect(httpSpy).not.toHaveBeenCalled();
  });
});
