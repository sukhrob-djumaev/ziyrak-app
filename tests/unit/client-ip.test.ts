import { afterEach, describe, expect, it, vi } from "vitest";
import { getClientIp } from "@/lib/client-ip";
import { logger } from "@/lib/observability/logger";

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

describe("getClientIp production configuration guard", () => {
  afterEach(() => {
    delete process.env.TRUSTED_PROXY_HOPS;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("logs a clear error once in production when TRUSTED_PROXY_HOPS is unset, because a client could then choose its own rate-limit address", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.TRUSTED_PROXY_HOPS;
    vi.resetModules();
    const { logger: freshLogger } = await import("@/lib/observability/logger");
    const error = vi.spyOn(freshLogger, "error").mockImplementation(() => undefined);
    const { getClientIp: fresh } = await import("@/lib/client-ip");
    fresh(req({ "x-forwarded-for": "1.1.1.1" }));
    fresh(req({ "x-forwarded-for": "2.2.2.2" }));
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toMatch(/TRUSTED_PROXY_HOPS/);
  });

  it("stays quiet outside production or when the hop count is configured", async () => {
    vi.resetModules();
    const { logger: freshLogger } = await import("@/lib/observability/logger");
    const error = vi.spyOn(freshLogger, "error").mockImplementation(() => undefined);
    const { getClientIp: fresh } = await import("@/lib/client-ip");
    fresh(req({ "x-forwarded-for": "1.1.1.1" }));
    vi.stubEnv("NODE_ENV", "production");
    process.env.TRUSTED_PROXY_HOPS = "1";
    fresh(req({ "x-forwarded-for": "9.9.9.9, 4.4.4.4" }));
    expect(error).not.toHaveBeenCalled();
    void logger;
  });
});
