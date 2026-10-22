import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

/** PLAN.md P3 — invitations bound to recipient, workspace, role and scope; real Postgres, capture mail. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { CaptureMailTransport, setMailTransportForTesting } from "@/lib/mail/transport";
import { createInvitation, listInvitations, revokeInvitation, previewInvitation, acceptInvitation } from "@/lib/platform/admin-users/invitations";
import { hashPassword, verifyPassword } from "@/lib/identity/auth";
import { seedBusiness, cleanupBusiness, addMember, type SeededBusiness } from "../helpers/tenant-fixtures";
import type { TenantContext } from "@/lib/tenancy/context";

const mail = new CaptureMailTransport();
let a: SeededBusiness;
let b: SeededBusiness;
const extraUsers: string[] = [];
const addr = () => `inv-${randomUUID()}@example.test`;
const tokenIn = (text: string) => text.match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
const human = (s: SeededBusiness, role: string): TenantContext => ({
  ...s.ctx,
  role,
  actor: { kind: "user", userId: s.ownerUserId },
  resourceScope: { kind: "workspace", customerProfileAccess: "write" },
});
async function verifiedUser(email: string, extra: object = {}) {
  const u = await prisma.user.create({
    data: { username: `iv_${randomUUID().slice(0, 12)}`, password: await hashPassword("Old-password-123"), name: "V", email, emailVerifiedAt: new Date(), ...extra },
  });
  extraUsers.push(u.id);
  return u;
}
const invite = async (email = addr(), over: object = {}) => {
  const res = await createInvitation(human(a, "owner"), { email, role: "agent", ...over });
  const token = tokenIn(mail.messages.at(-1)!.text);
  return { res, token, email };
};
const signup = { username: "", password: "Correct-horse-9", name: "New Person" };
const newName = () => `iv_${randomUUID().slice(0, 12)}`;

beforeAll(async () => {
  setMailTransportForTesting(mail);
  a = await seedBusiness("inv-a");
  b = await seedBusiness("inv-b");
  // Inviters must have a confirmed email (P3): confirm the seeded owners' addresses.
  for (const owner of [a, b]) {
    await prisma.user.update({ where: { id: owner.ownerUserId }, data: { email: `owner-${owner.ownerUserId}@example.test`, emailVerifiedAt: new Date() } });
  }
});
afterAll(async () => {
  setMailTransportForTesting(null);
  await cleanupBusiness(a.businessId);
  await cleanupBusiness(b.businessId);
  await prisma.user.deleteMany({ where: { id: { in: extraUsers } } });
});
beforeEach(async () => {
  mail.messages.length = 0;
  const { resetRateLimitsForTesting } = await import("@/lib/rate-limit");
  await resetRateLimitsForTesting();
});

describe("invitation abuse limits", () => {
  it("needs an inviter with a confirmed email", async () => {
    const unverified = await seedBusiness("inv-unverified");
    try {
      await expect(createInvitation(human(unverified, "owner"), { email: addr(), role: "viewer" })).rejects.toMatchObject({ statusCode: 403 });
      expect(mail.messages).toHaveLength(0);
    } finally {
      await cleanupBusiness(unverified.businessId);
    }
  });

  it("caps invitations per address per day and per workspace per hour", async () => {
    const target = addr();
    for (let i = 0; i < 3; i++) {
      const sent = await createInvitation(human(a, "owner"), { email: target, role: "viewer" });
      await revokeInvitation(human(a, "owner"), sent.id);
    }
    await expect(createInvitation(human(a, "owner"), { email: target, role: "viewer" })).rejects.toMatchObject({ statusCode: 429 });
    const { resetRateLimitsForTesting } = await import("@/lib/rate-limit");
    await resetRateLimitsForTesting();
    let refused = 0;
    for (let i = 0; i < 55; i++) {
      try {
        await createInvitation(human(a, "owner"), { email: addr(), role: "viewer" });
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 429) refused++;
      }
    }
    expect(refused).toBeGreaterThan(0);
    await resetRateLimitsForTesting();
  });
});

describe("creating invitations", () => {
  it("mails the recipient one link naming the workspace and stores only a hash", async () => {
    const { res, token, email } = await invite();
    expect(mail.messages).toHaveLength(1);
    expect(mail.messages[0].to).toBe(email);
    expect(mail.messages[0].text).toMatch(/\/accept-invitation\?token=/);
    expect(res).toMatchObject({ email, role: "agent" });
    const row = await prisma.accountToken.findFirstOrThrow({ where: { email, purpose: "invitation" } });
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("never grants ownership or an unknown role, and needs workspace-wide human authority", async () => {
    await expect(createInvitation(human(a, "owner"), { email: addr(), role: "owner" })).rejects.toMatchObject({ statusCode: 403 });
    await expect(createInvitation(human(a, "owner"), { email: addr(), role: "superuser" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createInvitation(human(a, "agent"), { email: addr(), role: "viewer" })).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      createInvitation({ ...human(a, "owner"), resourceScope: { kind: "connections", connectionIds: ["x"], customerProfileAccess: "write" } }, { email: addr(), role: "viewer" })
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(createInvitation({ ...human(a, "owner"), actor: { kind: "api_key", keyId: "k" } as never }, { email: addr(), role: "viewer" })).rejects.toMatchObject({ statusCode: 403 });
    expect(mail.messages).toHaveLength(0);
  });

  it("cannot grant more customer-profile access than the inviter holds, or connections of another workspace", async () => {
    const limited = { ...human(a, "admin"), resourceScope: { kind: "workspace", customerProfileAccess: "read" } } as TenantContext;
    await expect(createInvitation(limited, { email: addr(), role: "agent", scope: { kind: "workspace", customerProfileAccess: "write" } })).rejects.toMatchObject({ statusCode: 403 });
    const foreign = await prisma.channelConnection.create({ data: { businessId: b.businessId, type: "webchat", name: "B", isActive: true } });
    await expect(
      createInvitation(human(a, "owner"), { email: addr(), role: "agent", scope: { kind: "connections", connectionIds: [foreign.id], customerProfileAccess: "none" } })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("allows one open invitation per address and workspace; revoking frees it", async () => {
    const { res, email } = await invite();
    await expect(createInvitation(human(a, "owner"), { email, role: "viewer" })).rejects.toMatchObject({ statusCode: 409 });
    // Another workspace may invite the same address independently.
    await expect(createInvitation(human(b, "owner"), { email, role: "viewer" })).resolves.toBeTruthy();
    await revokeInvitation(human(a, "owner"), res.id);
    await expect(createInvitation(human(a, "owner"), { email, role: "viewer" })).resolves.toBeTruthy();
  });

  it("lists and revokes only this workspace's pending invitations", async () => {
    const { res } = await invite();
    const other = await createInvitation(human(b, "owner"), { email: addr(), role: "viewer" });
    const listA = await listInvitations(human(a, "owner"));
    expect(listA.map((i) => i.id)).toContain(res.id);
    expect(listA.map((i) => i.id)).not.toContain(other.id);
    await expect(revokeInvitation(human(a, "owner"), other.id)).rejects.toMatchObject({ statusCode: 404 });
    await revokeInvitation(human(a, "owner"), res.id);
    expect((await listInvitations(human(a, "owner"))).map((i) => i.id)).not.toContain(res.id);
  });
});

describe("accepting as a new person", () => {
  it("creates the account with the invited email already verified, the invited role and scope, once", async () => {
    const { token, email } = await invite(addr(), { role: "supervisor", scope: { kind: "workspace", customerProfileAccess: "read" } });
    const username = newName();
    const result = await acceptInvitation({ token, signup: { ...signup, username } });
    expect(result).toMatchObject({ ok: true, businessId: a.businessId });
    const user = await prisma.user.findUniqueOrThrow({ where: { username } });
    extraUsers.push(user.id);
    expect(user).toMatchObject({ email, platformRole: null });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await verifyPassword(signup.password, user.password)).toBe(true);
    expect(await prisma.membership.findFirstOrThrow({ where: { userId: user.id, businessId: a.businessId } })).toMatchObject({
      role: "supervisor", scopeMode: "workspace", customerProfileAccess: "read",
    });
    expect(await acceptInvitation({ token, signup: { ...signup, username: newName() } })).toMatchObject({ ok: false, code: "INVALID_LINK" });
  });

  it("applies a connection scope exactly as invited", async () => {
    const conn = await prisma.channelConnection.create({ data: { businessId: a.businessId, type: "webchat", name: "A", isActive: true } });
    const { token } = await invite(addr(), { role: "agent", scope: { kind: "connections", connectionIds: [conn.id], customerProfileAccess: "none" } });
    const username = newName();
    await acceptInvitation({ token, signup: { ...signup, username } });
    const user = await prisma.user.findUniqueOrThrow({ where: { username } });
    extraUsers.push(user.id);
    const m = await prisma.membership.findFirstOrThrow({ where: { userId: user.id, businessId: a.businessId }, include: { connectionScopes: true } });
    expect(m.scopeMode).toBe("connections");
    expect(m.connectionScopes.map((s) => s.connectionId)).toEqual([conn.id]);
  });

  it("rejects a weak password or taken username without burning the link", async () => {
    const { token } = await invite();
    expect(await acceptInvitation({ token, signup: { ...signup, username: newName(), password: "short" } })).toMatchObject({ ok: false, code: "INVALID_PASSWORD" });
    const taken = (await prisma.user.findUniqueOrThrow({ where: { id: a.ownerUserId } })).username;
    expect(await acceptInvitation({ token, signup: { ...signup, username: taken } })).toMatchObject({ ok: false, code: "USERNAME_TAKEN" });
    const username = newName();
    expect(await acceptInvitation({ token, signup: { ...signup, username } })).toMatchObject({ ok: true });
    extraUsers.push((await prisma.user.findUniqueOrThrow({ where: { username } })).id);
  });

  it("is refused after expiry, revocation or when the inviter lost the authority to invite", async () => {
    const expired = await invite();
    await prisma.accountToken.updateMany({ where: { email: expired.email, purpose: "invitation" }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await acceptInvitation({ token: expired.token, signup: { ...signup, username: newName() } })).toMatchObject({ ok: false, code: "INVALID_LINK" });

    const revoked = await invite();
    await revokeInvitation(human(a, "owner"), revoked.res.id);
    expect(await acceptInvitation({ token: revoked.token, signup: { ...signup, username: newName() } })).toMatchObject({ ok: false, code: "INVALID_LINK" });

    const admin = await addMember(a.businessId, "admin");
    await prisma.user.update({ where: { id: admin.userId }, data: { email: addr(), emailVerifiedAt: new Date() } });
    const adminCtx: TenantContext = { ...human(a, "admin"), actor: { kind: "user", userId: admin.userId } };
    const byAdmin = await createInvitation(adminCtx, { email: addr(), role: "agent" });
    const adminToken = tokenIn(mail.messages.at(-1)!.text);
    await prisma.membership.update({ where: { businessId_userId: { businessId: a.businessId, userId: admin.userId } }, data: { role: "viewer" } });
    expect(await acceptInvitation({ token: adminToken, signup: { ...signup, username: newName() } })).toMatchObject({ ok: false, code: "INVALID_LINK" });
    void byAdmin;
  });
});

describe("accepting as an existing person", () => {
  it("asks an existing verified account to sign in first, without burning the link", async () => {
    const email = addr();
    await verifiedUser(email);
    const { token } = await invite(email);
    expect(await acceptInvitation({ token })).toMatchObject({ ok: false, code: "SIGN_IN_REQUIRED" });
    expect(await prisma.accountToken.count({ where: { email, purpose: "invitation", usedAt: null } })).toBe(1);
  });

  it("joins the signed-in account matching the invited email with a second membership, no second identity", async () => {
    const email = addr();
    const person = await verifiedUser(email);
    const { token } = await invite(email, { role: "viewer" });
    expect(await acceptInvitation({ token, sessionUserId: person.id })).toMatchObject({ ok: true, userId: person.id });
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    expect(await prisma.membership.findFirstOrThrow({ where: { userId: person.id, businessId: a.businessId } })).toMatchObject({ role: "viewer" });
  });

  it("refuses a different signed-in account and a platform account, without burning the link", async () => {
    const email = addr();
    await verifiedUser(email);
    const stranger = await verifiedUser(addr());
    const operator = await verifiedUser(addr(), { platformRole: "operator" });
    const { token } = await invite(email);
    expect(await acceptInvitation({ token, sessionUserId: stranger.id })).toMatchObject({ ok: false, code: "WRONG_ACCOUNT" });
    expect(await acceptInvitation({ token, sessionUserId: operator.id })).toMatchObject({ ok: false, code: "WRONG_ACCOUNT" });
    expect(await prisma.accountToken.count({ where: { email, purpose: "invitation", usedAt: null } })).toBe(1);
    expect(await prisma.membership.count({ where: { userId: { in: [stranger.id, operator.id] }, businessId: a.businessId } })).toBe(0);
  });

  it("an unverified account holding the address does not receive the membership", async () => {
    const email = addr();
    const squatter = await prisma.user.create({ data: { username: newName(), password: "x", name: "S", email } });
    extraUsers.push(squatter.id);
    const { token } = await invite(email);
    expect(await acceptInvitation({ token, sessionUserId: squatter.id })).toMatchObject({ ok: false, code: "WRONG_ACCOUNT" });
  });

  it("does not duplicate a membership for someone already in the workspace", async () => {
    const email = addr();
    const person = await verifiedUser(email);
    await prisma.membership.create({ data: { businessId: a.businessId, userId: person.id, role: "viewer" } });
    const { token } = await invite(email, { role: "admin" });
    expect(await acceptInvitation({ token, sessionUserId: person.id })).toMatchObject({ ok: true });
    expect(await prisma.membership.findMany({ where: { userId: person.id, businessId: a.businessId } })).toHaveLength(1);
    expect((await prisma.membership.findFirstOrThrow({ where: { userId: person.id, businessId: a.businessId } })).role).toBe("viewer");
  });
});

describe("preview", () => {
  it("shows workspace, role and whether an account exists, without consuming the link", async () => {
    const email = addr();
    await verifiedUser(email);
    const { token } = await invite(email);
    expect(await previewInvitation(token)).toMatchObject({ email, role: "agent", existingAccount: true });
    expect(await previewInvitation("nope".repeat(12))).toBeNull();
    expect(await acceptInvitation({ token })).toMatchObject({ code: "SIGN_IN_REQUIRED" });
  });
});
