import { describe, it, expect, vi, afterAll } from "vitest";

/** PLAN.md P3 — expiring, single-use, hashed account tokens bound to purpose and recipient, real Postgres. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { issueAccountToken, consumeAccountToken, purgeExpiredAccountTokens } from "@/lib/identity/account-tokens";
import { randomUUID } from "node:crypto";

const emails: string[] = [];
const email = () => {
  const e = `tok-${randomUUID()}@example.test`;
  emails.push(e);
  return e;
};
afterAll(async () => {
  await prisma.accountToken.deleteMany({ where: { email: { in: emails } } });
});

describe("issue and consume", () => {
  it("stores only a hash of the secret, never the secret", async () => {
    const to = email();
    const { token } = await issueAccountToken({ purpose: "verify_email", email: to, ttlMs: 60_000 });
    const row = await prisma.accountToken.findFirstOrThrow({ where: { email: to } });
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("consumes once; a replay fails", async () => {
    const to = email();
    const { token } = await issueAccountToken({ purpose: "reset_password", email: to, ttlMs: 60_000 });
    const first = await consumeAccountToken({ token, purpose: "reset_password" });
    expect(first?.email).toBe(to);
    expect(await consumeAccountToken({ token, purpose: "reset_password" })).toBeNull();
  });

  it("concurrent consumption succeeds exactly once", async () => {
    const to = email();
    const { token } = await issueAccountToken({ purpose: "verify_email", email: to, ttlMs: 60_000 });
    const results = await Promise.all(Array.from({ length: 10 }, () => consumeAccountToken({ token, purpose: "verify_email" })));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("rejects an expired token", async () => {
    const to = email();
    const { token } = await issueAccountToken({ purpose: "verify_email", email: to, ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(await consumeAccountToken({ token, purpose: "verify_email" })).toBeNull();
  });

  it("is bound to its purpose: a verify token cannot reset a password or accept an invitation", async () => {
    const to = email();
    const { token } = await issueAccountToken({ purpose: "verify_email", email: to, ttlMs: 60_000 });
    expect(await consumeAccountToken({ token, purpose: "reset_password" })).toBeNull();
    expect(await consumeAccountToken({ token, purpose: "invitation" })).toBeNull();
    // A wrong-purpose attempt must not burn the token.
    expect(await consumeAccountToken({ token, purpose: "verify_email" })).not.toBeNull();
  });

  it("can be bound to a recipient, and a different recipient does not consume it", async () => {
    const to = email();
    const { token } = await issueAccountToken({ purpose: "invitation", email: to, ttlMs: 60_000, payload: { role: "agent" } });
    expect(await consumeAccountToken({ token, purpose: "invitation", email: email() })).toBeNull();
    const ok = await consumeAccountToken({ token, purpose: "invitation", email: to.toUpperCase() });
    expect(ok?.payload).toEqual({ role: "agent" });
  });

  it("rejects garbage, empty and tampered tokens without throwing", async () => {
    const to = email();
    const { token } = await issueAccountToken({ purpose: "verify_email", email: to, ttlMs: 60_000 });
    for (const bad of ["", "x", "a".repeat(500), token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), token + "x"]) {
      expect(await consumeAccountToken({ token: bad, purpose: "verify_email" })).toBeNull();
    }
  });

  it("issuing a new token of the same purpose and recipient invalidates the older one", async () => {
    const to = email();
    const a = await issueAccountToken({ purpose: "reset_password", email: to, ttlMs: 60_000 });
    const b = await issueAccountToken({ purpose: "reset_password", email: to, ttlMs: 60_000 });
    expect(await consumeAccountToken({ token: a.token, purpose: "reset_password" })).toBeNull();
    expect(await consumeAccountToken({ token: b.token, purpose: "reset_password" })).not.toBeNull();
  });

  it("purge removes only expired or used rows", async () => {
    const to = email();
    await issueAccountToken({ purpose: "verify_email", email: to, ttlMs: 1 });
    const keep = await issueAccountToken({ purpose: "invitation", email: to, ttlMs: 3_600_000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(await purgeExpiredAccountTokens()).toBeGreaterThanOrEqual(1);
    expect(await consumeAccountToken({ token: keep.token, purpose: "invitation" })).not.toBeNull();
  });
});
