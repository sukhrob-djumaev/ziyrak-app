import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

/** L1.3 / F03 — reset token consumption, password change and session cutoff succeed or fail together. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { issueAccountToken } from "@/lib/identity/account-tokens";
import { completePasswordReset } from "@/lib/identity/account-service";
import { generateToken, verifyActiveToken, hashPassword, verifyPassword } from "@/lib/identity/auth";

const ids: string[] = [];
async function verifiedUser() {
  const email = `reset-${randomUUID()}@example.test`;
  const u = await prisma.user.create({
    data: {
      username: `reset-${randomUUID()}`,
      password: await hashPassword("Old-password-123"),
      name: "T",
      email,
      emailVerifiedAt: new Date(),
    },
  });
  ids.push(u.id);
  return { u, email };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(async () => {
  await prisma.accountToken.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
beforeAll(() => undefined);

describe("password reset atomicity (F03)", () => {
  it("rolls everything back when the write after the token claim fails: token still usable, password and sessions untouched", async () => {
    const { u, email } = await verifiedUser();
    const { token } = await issueAccountToken({ purpose: "reset_password", email, userId: u.id, ttlMs: 60_000 });
    const session = generateToken(u.id);
    await wait(1100);

    const real = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>) =>
      real((tx: Record<string, unknown>) =>
        fn(
          new Proxy(tx, {
            get(target, prop) {
              if (prop === "user") {
                return new Proxy(target.user as object, {
                  get(m, name) {
                    if (name === "update") return () => Promise.reject(new Error("injected failure after token claim"));
                    return (m as Record<string, unknown>)[name as string];
                  },
                });
              }
              return target[prop as string];
            },
          })
        )
      )) as never);

    await expect(completePasswordReset(token, "New-password-456")).rejects.toThrow(/injected failure/);
    spy.mockRestore();

    const used = await prisma.accountToken.findFirst({ where: { userId: u.id, purpose: "reset_password" } });
    expect(used?.usedAt).toBeNull(); // the link was not burned by the failed attempt
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(await verifyPassword("Old-password-123", row.password)).toBe(true);
    expect(row.sessionsValidAfter).toBeNull();
    expect(await verifyActiveToken(session)).not.toBeNull();

    // And the retry with the same link works.
    expect(await completePasswordReset(token, "New-password-456")).toEqual({ userId: u.id });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(await verifyPassword("New-password-456", after.password)).toBe(true);
    expect(await verifyActiveToken(session)).toBeNull();
  });

  it("lets exactly one of several concurrent completions win, and the password is the winner's", async () => {
    const { u, email } = await verifiedUser();
    const { token } = await issueAccountToken({ purpose: "reset_password", email, userId: u.id, ttlMs: 60_000 });
    const attempts = ["Pass-word-aaaa1", "Pass-word-bbbb2", "Pass-word-cccc3", "Pass-word-dddd4"];
    const results = await Promise.all(attempts.map((p) => completePasswordReset(token, p).catch(() => null)));
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    const matches = await Promise.all(attempts.map((p) => verifyPassword(p, row.password)));
    expect(matches.filter(Boolean)).toHaveLength(1);
    expect(row.sessionsValidAfter).not.toBeNull();
  });

  it("still burns the link when the account no longer qualifies (no state change, no leak)", async () => {
    const { u, email } = await verifiedUser();
    const { token } = await issueAccountToken({ purpose: "reset_password", email, userId: u.id, ttlMs: 60_000 });
    await prisma.user.update({ where: { id: u.id }, data: { email: `changed-${randomUUID()}@example.test` } });
    expect(await completePasswordReset(token, "New-password-456")).toBeNull();
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(await verifyPassword("Old-password-123", row.password)).toBe(true);
    expect(await completePasswordReset(token, "New-password-456")).toBeNull();
  });
});
