import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

/** PLAN.md P3 — email verification and password recovery, real Postgres, capture mail transport. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { CaptureMailTransport, setMailTransportForTesting, MailNotConfiguredError, getMailTransport } from "@/lib/mail/transport";
import { sendVerification, confirmEmail, requestPasswordReset, completePasswordReset, startEmailChange } from "@/lib/identity/account-service";
import { generateToken, verifyActiveToken, hashPassword, verifyPassword } from "@/lib/identity/auth";

const mail = new CaptureMailTransport();
const ids: string[] = [];
const tokenIn = (m: { text: string }) => m.text.match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
async function user(email: string | null, verified = false, extra: object = {}) {
  const u = await prisma.user.create({
    data: {
      username: `acct-${randomUUID()}`,
      password: await hashPassword("Old-password-123"),
      name: "T",
      email,
      emailVerifiedAt: verified ? new Date() : null,
      ...extra,
    },
  });
  ids.push(u.id);
  return u;
}
const addr = () => `acct-${randomUUID()}@example.test`;

beforeAll(() => setMailTransportForTesting(mail));
afterAll(async () => {
  setMailTransportForTesting(null);
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
beforeEach(() => {
  mail.messages.length = 0;
});

describe("email verification", () => {
  it("sends one mail with a link, verifies once, and a replay fails", async () => {
    const to = addr();
    const u = await user(to);
    await sendVerification(u.id);
    expect(mail.messages).toHaveLength(1);
    expect(mail.messages[0].to).toBe(to);
    expect(mail.messages[0].text).toMatch(/\/verify-email\?token=/);
    const token = tokenIn(mail.messages[0]);
    expect(await confirmEmail(token)).toEqual({ userId: u.id });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).emailVerifiedAt).not.toBeNull();
    expect(await confirmEmail(token)).toBeNull();
  });

  it("refuses a token whose address is no longer the account's address", async () => {
    const u = await user(addr());
    await sendVerification(u.id);
    const token = tokenIn(mail.messages[0]);
    await prisma.user.update({ where: { id: u.id }, data: { email: addr() } });
    expect(await confirmEmail(token)).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).emailVerifiedAt).toBeNull();
  });

  it("lets only one account verify a given address; the other claim is refused", async () => {
    const shared = addr();
    const first = await user(shared);
    const second = await user(shared);
    await sendVerification(first.id);
    await sendVerification(second.id);
    const [t1, t2] = mail.messages.map(tokenIn);
    expect(await confirmEmail(t1)).toEqual({ userId: first.id });
    expect(await confirmEmail(t2)).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: second.id } })).emailVerifiedAt).toBeNull();
  });

  it("sends nothing for an account without an email or already verified", async () => {
    await sendVerification((await user(null)).id);
    await sendVerification((await user(addr(), true)).id);
    expect(mail.messages).toHaveLength(0);
  });
});

describe("password reset", () => {
  it("mails a reset link only to a verified, non-platform account; every other request looks identical", async () => {
    const verified = addr();
    const v = await user(verified, true);
    const unverified = await user(addr());
    const platform = await user(addr(), true, { platformRole: "operator" });
    const results = [];
    for (const email of [verified, unverified.email!, platform.email!, addr()]) {
      results.push(await requestPasswordReset(email));
    }
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(mail.messages.map((m) => m.to)).toEqual([verified]);
    expect(mail.messages[0].text).not.toContain("Old-password-123");
    void v;
  });

  it("sets the new password, ends earlier sessions, and cannot be replayed", async () => {
    const to = addr();
    const u = await user(to, true);
    const oldSession = generateToken(u.id);
    await requestPasswordReset(to);
    const token = tokenIn(mail.messages[0]);
    await new Promise((r) => setTimeout(r, 1100));
    expect(await completePasswordReset(token, "A-brand-new-password-9")).toEqual({ userId: u.id });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(await verifyPassword("A-brand-new-password-9", row.password)).toBe(true);
    expect(await verifyPassword("Old-password-123", row.password)).toBe(false);
    expect(await verifyActiveToken(oldSession)).toBeNull();
    expect(await completePasswordReset(token, "Another-password-77")).toBeNull();
  });

  it("rejects a weak or oversized password without consuming the token", async () => {
    const to = addr();
    await user(to, true);
    await requestPasswordReset(to);
    const token = tokenIn(mail.messages[0]);
    for (const bad of ["short", "x".repeat(73), ""]) {
      expect(await completePasswordReset(token, bad)).toBeNull();
    }
    expect(await completePasswordReset(token, "A-brand-new-password-9")).not.toBeNull();
  });

  it("a newer request invalidates the older link", async () => {
    const to = addr();
    await user(to, true);
    await requestPasswordReset(to);
    await requestPasswordReset(to);
    const [older, newer] = mail.messages.map(tokenIn);
    expect(await completePasswordReset(older, "A-brand-new-password-9")).toBeNull();
    expect(await completePasswordReset(newer, "A-brand-new-password-9")).not.toBeNull();
  });

  it("a verification token cannot reset a password", async () => {
    const to = addr();
    const u = await user(to);
    await sendVerification(u.id);
    expect(await completePasswordReset(tokenIn(mail.messages[0]), "A-brand-new-password-9")).toBeNull();
  });
});

describe("adopting or changing an email (self-service)", () => {
  const PW = "Old-password-123";
  it("an account without an email adds one: nothing is stored until the link from the new mailbox is used", async () => {
    const u = await user(null);
    const to = addr();
    expect(await startEmailChange(u.id, to, PW)).toEqual({ accepted: true });
    expect(mail.messages.map((m) => m.to)).toEqual([to]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).email).toBeNull();
    expect(await confirmEmail(tokenIn(mail.messages[0]))).toEqual({ userId: u.id });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({ email: to, emailVerifiedAt: expect.any(Date) });
  });

  it("requires the current password, so a stolen session cannot bind a new mailbox", async () => {
    const u = await user(null);
    expect(await startEmailChange(u.id, addr(), "wrong-password-1")).toBeNull();
    expect(mail.messages).toHaveLength(0);
  });

  it("looks identical when the address is already verified by someone else, mails no link, and warns the holder", async () => {
    const holderEmail = addr();
    await user(holderEmail, true);
    const u = await user(null);
    const free = await startEmailChange(u.id, addr(), PW);
    mail.messages.length = 0;
    expect(await startEmailChange(u.id, holderEmail, PW)).toEqual(free);
    expect(mail.messages.map((m) => m.to)).toEqual([holderEmail]);
    expect(mail.messages[0].text).not.toMatch(/token=/);
  });

  it("keeps the old verified address until the new one is confirmed, then retires the old reset path", async () => {
    const oldAddr = addr();
    const next = addr();
    const u = await user(oldAddr, true);
    await startEmailChange(u.id, next, PW);
    const changeToken = tokenIn(mail.messages[0]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).email).toBe(oldAddr);
    await requestPasswordReset(oldAddr);
    const staleReset = tokenIn(mail.messages[1]);
    expect(await confirmEmail(changeToken)).toEqual({ userId: u.id });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).email).toBe(next);
    expect(await completePasswordReset(staleReset, "A-brand-new-password-9")).toBeNull();
  });

  it("refuses platform accounts", async () => {
    const p = await user(addr(), true, { platformRole: "operator" });
    expect(await startEmailChange(p.id, addr(), PW)).toBeNull();
    expect(mail.messages).toHaveLength(0);
  });
});

describe("transport selection", () => {
  it("an unconfigured production transport fails loudly instead of pretending to send", async () => {
    setMailTransportForTesting(null);
    const before = { t: process.env.MAIL_TRANSPORT, h: process.env.PLATFORM_SMTP_HOST, n: process.env.NODE_ENV };
    delete process.env.MAIL_TRANSPORT;
    delete process.env.PLATFORM_SMTP_HOST;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      await expect(getMailTransport().send({ to: "a@b.test", subject: "s", text: "t" })).rejects.toBeInstanceOf(MailNotConfiguredError);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = before.n;
      if (before.t !== undefined) process.env.MAIL_TRANSPORT = before.t;
      if (before.h !== undefined) process.env.PLATFORM_SMTP_HOST = before.h;
      setMailTransportForTesting(mail);
    }
  });
});
