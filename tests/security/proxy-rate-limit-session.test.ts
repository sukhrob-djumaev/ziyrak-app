import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";

/**
 * The dashboard makes several background requests per page (account menu, approvals
 * badge, live updates), so a per-IP limit of 60/min would let a handful of open tabs
 * lock out everyone behind one address (an office NAT, a tunnel). Signed-in sessions
 * therefore get their own bucket, keyed by the verified user; the per-IP limit remains
 * for everything that is not a valid session (anonymous, API keys, forged tokens).
 */
vi.mock("@/lib/rate-limit", async (importOriginal) => importOriginal());

import { proxy } from "@/proxy";
import { generateToken } from "@/lib/identity/auth";
import { RATE_LIMITS, resetRateLimitsForTesting } from "@/lib/rate-limit";

const request = (path: string, opts: { token?: string; ip?: string; apiKey?: string } = {}) => {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? "198.51.100.7" };
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  const req = new NextRequest(`http://localhost:3000${path}`, { headers });
  if (opts.token) req.cookies.set("owly-token", opts.token);
  return req;
};
const statuses = async (n: number, make: () => NextRequest) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await proxy(make())).status);
  return out;
};

beforeEach(async () => {
  await resetRateLimitsForTesting();
});

describe("API rate limiting is per session, not only per address", () => {
  it("lets a signed-in session make far more requests than the per-IP limit", async () => {
    const token = generateToken("user-a");
    const result = await statuses(RATE_LIMITS.api.maxRequests * 3, () => request("/api/conversations", { token }));
    expect(result.filter((s) => s === 429)).toHaveLength(0);
  });

  it("still enforces a per-session limit", async () => {
    const token = generateToken("user-b");
    const result = await statuses(RATE_LIMITS.apiUser.maxRequests + 5, () => request("/api/conversations", { token }));
    expect(result.slice(0, RATE_LIMITS.apiUser.maxRequests).every((s) => s !== 429)).toBe(true);
    expect(result.slice(RATE_LIMITS.apiUser.maxRequests).every((s) => s === 429)).toBe(true);
  });

  it("does not let one user's traffic consume another user's budget behind the same address", async () => {
    const heavy = generateToken("heavy-user");
    await statuses(RATE_LIMITS.apiUser.maxRequests + 10, () => request("/api/conversations", { token: heavy }));
    const other = generateToken("other-user");
    expect((await proxy(request("/api/conversations", { token: other }))).status).not.toBe(429);
  });

  it("keeps the per-IP limit for anonymous requests and API keys", async () => {
    const anon = await statuses(RATE_LIMITS.api.maxRequests + 3, () => request("/api/conversations", { ip: "203.0.113.1" }));
    expect(anon.slice(RATE_LIMITS.api.maxRequests).every((s) => s === 429)).toBe(true);
    const keyed = await statuses(RATE_LIMITS.api.maxRequests + 3, () => request("/api/conversations", { ip: "203.0.113.2", apiKey: "zy_live_notarealkey000" }));
    expect(keyed.slice(RATE_LIMITS.api.maxRequests).every((s) => s === 429)).toBe(true);
  });

  it("does not let a forged token buy the larger budget", async () => {
    const forged = jwt.sign({ userId: "attacker" }, "not-the-server-secret", { expiresIn: "7d", jwtid: "x" });
    const result = await statuses(RATE_LIMITS.api.maxRequests + 3, () => request("/api/conversations", { token: forged, ip: "203.0.113.3" }));
    expect(result.slice(RATE_LIMITS.api.maxRequests).every((s) => s === 429)).toBe(true);
  });

  it("rotating the claimed user id does not help a forger (the signature is checked first)", async () => {
    let i = 0;
    const result = await statuses(RATE_LIMITS.api.maxRequests + 3, () =>
      request("/api/conversations", { token: jwt.sign({ userId: `fake-${i++}` }, "wrong-secret"), ip: "203.0.113.4" })
    );
    expect(result.slice(RATE_LIMITS.api.maxRequests).every((s) => s === 429)).toBe(true);
  });
});

describe("opening the live event stream", () => {
  it("has its own, smaller per-session budget so reconnect storms cannot starve ordinary requests", async () => {
    const token = generateToken("streamer");
    const opens = await statuses(RATE_LIMITS.stream.maxRequests + 5, () => request("/api/realtime?channel=global", { token }));
    expect(opens.slice(RATE_LIMITS.stream.maxRequests).every((s) => s === 429)).toBe(true);
    // ...while the same session's normal API calls are unaffected.
    expect((await proxy(request("/api/conversations", { token }))).status).not.toBe(429);
  });
});
