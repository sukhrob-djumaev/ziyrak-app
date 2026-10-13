import { afterEach, describe, expect, it } from "vitest";
import { getClientIp } from "@/lib/client-ip";

const req = (headers: Record<string, string>) => ({ headers: new Headers(headers) });

describe("getClientIp", () => {
  afterEach(() => {
    delete process.env.TRUSTED_PROXY_HOPS;
  });

  it("legacy default (no TRUSTED_PROXY_HOPS): first forwarded entry, then x-real-ip, then unknown", () => {
    expect(getClientIp(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("1.1.1.1");
    expect(getClientIp(req({ "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
    expect(getClientIp(req({}))).toBe("unknown");
  });

  it("with N trusted proxies, takes the entry the outermost trusted proxy appended, ignoring spoofed leading entries", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    // client sent a forged "9.9.9.9"; the one trusted proxy appended the real peer
    expect(getClientIp(req({ "x-forwarded-for": "9.9.9.9, 4.4.4.4" }))).toBe("4.4.4.4");
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(getClientIp(req({ "x-forwarded-for": "9.9.9.9, 4.4.4.4, 10.0.0.1" }))).toBe("4.4.4.4");
  });

  it("with trusted proxies configured, a chain shorter than the hop count falls back to the leftmost entry, never a spoofable header value beyond it", () => {
    process.env.TRUSTED_PROXY_HOPS = "3";
    expect(getClientIp(req({ "x-forwarded-for": "4.4.4.4" }))).toBe("4.4.4.4");
  });

  it("with trusted proxies configured, an absent forwarded header is unknown (x-real-ip is client-controlled unless set by the proxy)", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    expect(getClientIp(req({}))).toBe("unknown");
  });

  it("ignores a malformed hop setting", () => {
    process.env.TRUSTED_PROXY_HOPS = "abc";
    expect(getClientIp(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("1.1.1.1");
  });
});
