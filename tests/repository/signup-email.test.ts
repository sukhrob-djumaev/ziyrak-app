import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

/** PLAN.md P3 — signup with an email: unverified identity, inactive workspace, verification gates paid AI use. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { provisionBusiness } from "@/lib/platform/provisioning";
import { CaptureMailTransport, setMailTransportForTesting } from "@/lib/mail/transport";
import { confirmEmail } from "@/lib/identity/account-service";
import { resetRateLimitsForTesting } from "@/lib/rate-limit";
import { createRequest, parseJsonResponse } from "../helpers/request";

const mail = new CaptureMailTransport();
const businessIds: string[] = [];
const userIds: string[] = [];
const addr = () => `su-${randomUUID()}@Example.test`;
const uname = () => `su_${randomUUID().slice(0, 12)}`;
const tokenIn = (text: string) => text.match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
async function provision(extra: object = {}) {
  const r = await provisionBusiness({ businessName: "Signup Test Co", ownerUsername: uname(), ownerPassword: "Correct-horse-9", ...extra });
  businessIds.push(r.businessId);
  userIds.push(r.userId);
  return r;
}
const signup = (body: object) => createRequest("/api/auth", { method: "POST", body: { action: "signup", businessName: "Signup Test Co", password: "Correct-horse-9", ...body } });

beforeAll(() => setMailTransportForTesting(mail));
afterAll(async () => {
  setMailTransportForTesting(null);
  await prisma.business.deleteMany({ where: { id: { in: businessIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});
beforeEach(async () => {
  mail.messages.length = 0;
  await resetRateLimitsForTesting();
});

describe("provisionBusiness with an owner email", () => {
  it("creates an unverified identity, an inactive workspace and a managed allowance waiting for verification", async () => {
    const email = addr();
    const r = await provision({ ownerEmail: email });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: r.userId } });
    expect(user).toMatchObject({ email: email.toLowerCase(), emailVerifiedAt: null });
    expect((await prisma.onboardingState.findUniqueOrThrow({ where: { businessId: r.businessId } })).activatedAt).toBeNull();
    expect(await prisma.workspaceAiAllowance.findUniqueOrThrow({ where: { businessId: r.businessId } })).toMatchObject({
      mode: "managed",
      status: "pending_verification",
    });
  });

  it("without an email behaves as before: active workspace, no allowance, no email", async () => {
    const r = await provision();
    expect(await prisma.onboardingState.count({ where: { businessId: r.businessId } })).toBe(0);
    expect(await prisma.workspaceAiAllowance.count({ where: { businessId: r.businessId } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: r.userId } })).email).toBeNull();
  });

  it("verification activates the owner's managed allowance but never lifts an operator suspension", async () => {
    const r = await provision({ ownerEmail: addr() });
    const suspended = await provision({ ownerEmail: addr() });
    await prisma.workspaceAiAllowance.update({ where: { businessId: suspended.businessId }, data: { status: "suspended" } });
    for (const owner of [r, suspended]) {
      await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } });
    }
    const { sendVerification } = await import("@/lib/identity/account-service");
    await sendVerification(r.userId);
    await sendVerification(suspended.userId);
    for (const m of mail.messages) expect(await confirmEmail(tokenIn(m.text))).not.toBeNull();
    expect((await prisma.workspaceAiAllowance.findUniqueOrThrow({ where: { businessId: r.businessId } })).status).toBe("active");
    expect((await prisma.workspaceAiAllowance.findUniqueOrThrow({ where: { businessId: suspended.businessId } })).status).toBe("suspended");
  });
});

describe("POST /api/auth signup", () => {
  it("requires a valid email", async () => {
    const { POST } = await import("@/app/api/auth/route");
    for (const email of [undefined, "", "nope", "a@b", "x".repeat(300) + "@example.test"]) {
      const res = await POST(signup({ username: uname(), email }));
      expect(res.status).toBe(400);
    }
  });

  it("answers 202 with no session, mails the verification link, and creates the inactive workspace", async () => {
    const { POST } = await import("@/app/api/auth/route");
    const email = addr();
    const username = uname();
    const res = await POST(signup({ username, email }));
    expect(res.status).toBe(202);
    expect(res.headers.get("set-cookie")).toBeNull();
    // The verification mail is sent after the response; wait for it.
    for (let i = 0; i < 50 && mail.messages.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(mail.messages.map((m) => m.to)).toEqual([email.toLowerCase()]);
    const user = await prisma.user.findUniqueOrThrow({ where: { username } });
    userIds.push(user.id);
    const membership = await prisma.membership.findFirstOrThrow({ where: { userId: user.id } });
    businessIds.push(membership.businessId);
    expect((await prisma.onboardingState.findUniqueOrThrow({ where: { businessId: membership.businessId } })).activatedAt).toBeNull();
  });

  it("gives the identical answer for an address already verified elsewhere, creates nothing, and warns the holder", async () => {
    const { POST } = await import("@/app/api/auth/route");
    const holder = await provision({ ownerEmail: addr() });
    const holderRow = await prisma.user.findUniqueOrThrow({ where: { id: holder.userId } });
    await prisma.user.update({ where: { id: holder.userId }, data: { emailVerifiedAt: new Date() } });
    const freshName = uname();
    const conflictName = uname();
    const fresh = await POST(signup({ username: freshName, email: addr() }));
    const conflict = await POST(signup({ username: conflictName, email: holderRow.email!.toUpperCase() }));
    expect(conflict.status).toBe(fresh.status);
    expect(await parseJsonResponse(conflict)).toEqual(await parseJsonResponse(fresh));
    // The new address got an account and workspace; the contested one created nothing.
    const created = await prisma.user.findUnique({ where: { username: freshName } });
    expect(created).not.toBeNull();
    userIds.push(created!.id);
    for (const m of await prisma.membership.findMany({ where: { userId: created!.id } })) businessIds.push(m.businessId);
    expect(await prisma.user.findUnique({ where: { username: conflictName } })).toBeNull();
    expect(mail.messages.some((m) => m.to === holderRow.email && /already|did not/i.test(m.text))).toBe(true);
  });

  it("an unverified claim on an address does not block a signup", async () => {
    const { POST } = await import("@/app/api/auth/route");
    const shared = addr();
    await provision({ ownerEmail: shared });
    const username = uname();
    const res = await POST(signup({ username, email: shared }));
    expect(res.status).toBe(202);
    const created = await prisma.user.findUniqueOrThrow({ where: { username } });
    userIds.push(created.id);
    for (const m of await prisma.membership.findMany({ where: { userId: created.id } })) businessIds.push(m.businessId);
    expect(created.email).toBe(shared.toLowerCase());
  });

  it("reports a taken username the same way whether or not the address is verified elsewhere (no address oracle)", async () => {
    const { POST } = await import("@/app/api/auth/route");
    const taken = await provision({ ownerEmail: addr() });
    const takenName = (await prisma.user.findUniqueOrThrow({ where: { id: taken.userId } })).username;
    const holderEmail = addr();
    const holder = await provision({ ownerEmail: holderEmail });
    await prisma.user.update({ where: { id: holder.userId }, data: { emailVerifiedAt: new Date() } });
    const free = await POST(signup({ username: takenName, email: addr() }));
    const contested = await POST(signup({ username: takenName, email: holderEmail }));
    expect(contested.status).toBe(free.status);
    expect(await parseJsonResponse(contested)).toEqual(await parseJsonResponse(free));
  });

  it("warns the holder of a verified address at most three times an hour", async () => {
    const { POST } = await import("@/app/api/auth/route");
    const holderEmail = addr();
    const holder = await provision({ ownerEmail: holderEmail });
    await prisma.user.update({ where: { id: holder.userId }, data: { emailVerifiedAt: new Date() } });
    mail.messages.length = 0;
    for (let i = 0; i < 6; i++) await POST(signup({ username: uname(), email: holderEmail }));
    expect(mail.messages.filter((m) => m.to === holderEmail.toLowerCase())).toHaveLength(3);
  });

  it("still reports a taken username", async () => {
    const { POST } = await import("@/app/api/auth/route");
    const first = await provision({ ownerEmail: addr() });
    const taken = (await prisma.user.findUniqueOrThrow({ where: { id: first.userId } })).username;
    expect((await POST(signup({ username: taken, email: addr() }))).status).toBe(409);
  });
});
