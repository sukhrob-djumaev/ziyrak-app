import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

/** PLAN.md P3 — public recovery/verification endpoints: non-enumerating, replay-safe, session-ending. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { CaptureMailTransport, setMailTransportForTesting } from "@/lib/mail/transport";
import { generateToken, hashPassword, verifyActiveToken } from "@/lib/identity/auth";
import { resetRateLimitsForTesting } from "@/lib/rate-limit";
import { createRequest, parseJsonResponse } from "../helpers/request";

const mail = new CaptureMailTransport();
const ids: string[] = [];
const addr = () => `api-${randomUUID()}@example.test`;
const tokenIn = (text: string) => text.match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
async function user(email: string, verified: boolean) {
  const u = await prisma.user.create({
    data: { username: `api-${randomUUID()}`, password: await hashPassword("Old-password-123"), name: "T", email, emailVerifiedAt: verified ? new Date() : null },
  });
  ids.push(u.id);
  return u;
}
const post = (path: string, body: object, cookies: Record<string, string> = {}) =>
  createRequest(path, { method: "POST", body, cookies });

beforeAll(() => setMailTransportForTesting(mail));
afterAll(async () => {
  setMailTransportForTesting(null);
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
beforeEach(async () => {
  mail.messages.length = 0;
  await resetRateLimitsForTesting();
});

describe("POST /api/auth/forgot-password", () => {
  it("answers identically for known, unknown and malformed addresses and sets no cookie", async () => {
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const known = addr();
    await user(known, true);
    const responses = [];
    for (const email of [known, addr(), "not-an-email", ""]) {
      const res = await POST(post("/api/auth/forgot-password", { email }));
      responses.push({ status: res.status, body: await parseJsonResponse(res), cookie: res.headers.get("set-cookie") });
    }
    expect(new Set(responses.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(responses[0].status).toBe(200);
    expect(responses[0].cookie).toBeNull();
    expect(mail.messages.map((m) => m.to)).toEqual([known]);
  });

  it("another client cannot use up the address's own budget (per client+address, with a wider per-address ceiling)", async () => {
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const to = addr();
    await user(to, true);
    const asClient = (ip: string) => createRequest("/api/auth/forgot-password", { method: "POST", body: { email: to }, headers: { "x-forwarded-for": ip } });
    for (let i = 0; i < 5; i++) await POST(asClient("203.0.113.9"));
    expect(mail.messages).toHaveLength(3); // that client is capped at three
    await POST(asClient("203.0.113.77")); // a different client still gets a link
    expect(mail.messages).toHaveLength(4);
  });

  it("stops mailing after three requests per address per hour, with the same response", async () => {
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const to = addr();
    await user(to, true);
    const bodies = [];
    for (let i = 0; i < 5; i++) bodies.push(JSON.stringify(await parseJsonResponse(await POST(post("/api/auth/forgot-password", { email: to })))));
    expect(new Set(bodies).size).toBe(1);
    expect(mail.messages).toHaveLength(3);
  });
});

describe("POST /api/auth/reset-password", () => {
  it("changes the password with a valid link, ends old sessions, and rejects a replay generically", async () => {
    const { POST: forgot } = await import("@/app/api/auth/forgot-password/route");
    const { POST: reset } = await import("@/app/api/auth/reset-password/route");
    const to = addr();
    const u = await user(to, true);
    const old = generateToken(u.id);
    await forgot(post("/api/auth/forgot-password", { email: to }));
    const token = tokenIn(mail.messages[0].text);
    await new Promise((r) => setTimeout(r, 1100));
    const ok = await reset(post("/api/auth/reset-password", { token, password: "A-brand-new-password-9" }));
    expect(ok.status).toBe(200);
    expect(await verifyActiveToken(old)).toBeNull();
    const replay = await reset(post("/api/auth/reset-password", { token, password: "Yet-another-password-1" }));
    expect(replay.status).toBe(400);
    const wrong = await reset(post("/api/auth/reset-password", { token: "x".repeat(43), password: "Yet-another-password-1" }));
    expect(await parseJsonResponse(replay)).toEqual(await parseJsonResponse(wrong));
  });

  it("returns a field error for a weak password without consuming the link", async () => {
    const { POST: forgot } = await import("@/app/api/auth/forgot-password/route");
    const { POST: reset } = await import("@/app/api/auth/reset-password/route");
    const to = addr();
    await user(to, true);
    await forgot(post("/api/auth/forgot-password", { email: to }));
    const token = tokenIn(mail.messages[0].text);
    expect((await reset(post("/api/auth/reset-password", { token, password: "short" }))).status).toBe(400);
    expect((await reset(post("/api/auth/reset-password", { token, password: "A-brand-new-password-9" }))).status).toBe(200);
  });
});

describe("email verification endpoints", () => {
  it("verifies with a valid link once; an invalid or reused link gets one generic answer", async () => {
    const { POST: resend } = await import("@/app/api/auth/resend-verification/route");
    const { POST: verify } = await import("@/app/api/auth/verify-email/route");
    const u = await user(addr(), false);
    const res = await resend(post("/api/auth/resend-verification", {}, { "owly-token": generateToken(u.id) }));
    expect(res.status).toBe(200);
    const token = tokenIn(mail.messages[0].text);
    expect((await verify(post("/api/auth/verify-email", { token }))).status).toBe(200);
    const replay = await verify(post("/api/auth/verify-email", { token }));
    const junk = await verify(post("/api/auth/verify-email", { token: "z".repeat(43) }));
    expect(replay.status).toBe(400);
    expect(await parseJsonResponse(replay)).toEqual(await parseJsonResponse(junk));
  });

  it("resend requires a signed-in session and is limited per account", async () => {
    const { POST: resend } = await import("@/app/api/auth/resend-verification/route");
    expect((await resend(post("/api/auth/resend-verification", {}))).status).toBe(401);
    const u = await user(addr(), false);
    const cookies = { "owly-token": generateToken(u.id) };
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await resend(post("/api/auth/resend-verification", {}, cookies))).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});

describe("/api/auth/email", () => {
  it("requires a session; reads own state; changes only with the current password; answers alike for taken addresses", async () => {
    const { GET, POST } = await import("@/app/api/auth/email/route");
    expect((await GET(createRequest("/api/auth/email"))).status).toBe(401);
    expect((await POST(post("/api/auth/email", { email: addr(), password: "Old-password-123" }))).status).toBe(401);
    const u = await user(addr(), false);
    await prisma.user.update({ where: { id: u.id }, data: { email: null } });
    const cookies = { "owly-token": generateToken(u.id) };
    expect(await parseJsonResponse(await GET(createRequest("/api/auth/email", { cookies })))).toEqual({ email: null, verified: false });
    expect((await POST(post("/api/auth/email", { email: addr(), password: "wrong-password-1" }, cookies))).status).toBe(400);
    expect(mail.messages).toHaveLength(0);
    const taken = addr();
    await user(taken, true);
    const free = await POST(post("/api/auth/email", { email: addr(), password: "Old-password-123" }, cookies));
    const conflict = await POST(post("/api/auth/email", { email: taken, password: "Old-password-123" }, cookies));
    expect(conflict.status).toBe(free.status);
    expect(await parseJsonResponse(conflict)).toEqual(await parseJsonResponse(free));
  });
});
