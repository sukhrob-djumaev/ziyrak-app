import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { generateToken, revokeToken, verifyToken } from "@/lib/identity/auth";
import type { TenantContext } from "@/lib/tenancy/context";

let a: SeededBusiness, b: SeededBusiness;
const users = new Set<string>();
beforeEach(async () => {
  a = await seedBusiness("deferred-a");
  b = await seedBusiness("deferred-b");
  users.add(a.ownerUserId);
  users.add(b.ownerUserId);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupBusiness(a.businessId);
  await cleanupBusiness(b.businessId);
  await prisma.revokedToken.deleteMany({ where: { userId: { in: [...users] } } });
  await prisma.user.deleteMany({ where: { id: { in: [...users] } } });
  users.clear();
});
async function human() {
  const member = await prisma.membership.findUniqueOrThrow({
    where: { businessId_userId: { businessId: a.businessId, userId: a.ownerUserId } },
  });
  const token = generateToken(a.ownerUserId),
    session = verifyToken(token)!;
  const ctx: TenantContext = {
    ...a.ctx,
    authorization: {
      kind: "membership",
      userId: a.ownerUserId,
      membershipId: member.id,
      sessionJti: session.jti,
      sessionExpiresAt: session.exp,
    },
  };
  return { ctx, member, token };
}
async function key() {
  const h = await human();
  const row = await prisma.apiKey.create({
    data: {
      businessId: a.businessId,
      name: "Synthetic deferred key",
      keyPrefix: "test-only-" + randomUUID(),
      keyHash: randomUUID(),
      scopeMode: "workspace",
      scopeOrigin: "issuer",
      issuedByUserId: a.ownerUserId,
      customerProfileAccess: "read",
      role: "agent",
    },
  });
  const ctx: TenantContext = {
    ...a.ctx,
    role: "agent",
    actor: { kind: "api_key", apiKeyId: row.id },
    resourceScope: { kind: "workspace", customerProfileAccess: "read" },
    authorization: { kind: "api_key", apiKeyId: row.id },
  };
  return { ...h, key: row, ctx };
}
async function api() {
  return import("@/lib/tenancy/deferred-origin");
}
describe("deferred identity ceilings, real isolated Postgres; not queue admission", () => {
  it("captures exact membership without credentials, preserves human origin through AI retag, and reads current role after demotion", async () => {
    const { captureDeferredIdentity, refreshDeferredIdentity } = await api(),
      h = await human();
    const saved = await captureDeferredIdentity({
      ...h.ctx,
      role: null,
      actor: { kind: "ai_agent", conversationId: "synthetic-conversation", model: "stand-in" },
    });
    expect(saved.origin).toEqual({
      kind: "membership",
      userId: a.ownerUserId,
      membershipId: h.member.id,
    });
    expect(JSON.stringify(saved)).not.toMatch(/session|token|role|password|jti/i);
    await prisma.membership.update({ where: { id: h.member.id }, data: { role: "viewer" } });
    expect(await refreshDeferredIdentity(saved, a.businessId)).toMatchObject({
      role: "viewer",
      origin: saved.origin,
    });
  });
  it("keeps recorded intent after logout and session expiry, but removal/recreation never revives it", async () => {
    const { captureDeferredIdentity, refreshDeferredIdentity } = await api(),
      h = await human();
    const saved = await captureDeferredIdentity(h.ctx);
    await revokeToken(h.token);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 8 * 86400_000));
      expect(await refreshDeferredIdentity(saved, a.businessId)).toMatchObject({ role: "owner" });
    } finally {
      vi.useRealTimers();
    }
    await prisma.membership.delete({ where: { id: h.member.id } });
    await expect(refreshDeferredIdentity(saved, a.businessId)).rejects.toMatchObject({
      statusCode: 403,
    });
    await prisma.membership.create({
      data: { businessId: a.businessId, userId: a.ownerUserId, role: "owner" },
    });
    await expect(refreshDeferredIdentity(saved, a.businessId)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it("intersects fresh scope with the saved ceiling and never expands later permissions", async () => {
    const { captureDeferredIdentity, refreshDeferredIdentity } = await api(),
      h = await human();
    const first = await prisma.channelConnection.create({
        data: { businessId: a.businessId, type: "webchat", name: "A" },
      }),
      second = await prisma.channelConnection.create({
        data: { businessId: a.businessId, type: "email", name: "B" },
      });
    const saved = await captureDeferredIdentity({
      ...h.ctx,
      resourceScope: {
        kind: "connections",
        connectionIds: [first.id],
        customerProfileAccess: "none",
      },
    });
    expect((await refreshDeferredIdentity(saved, a.businessId)).scope).toEqual(saved.scope);
    await prisma.membership.update({
      where: { id: h.member.id },
      data: {
        scopeMode: "connections",
        customerProfileAccess: "read",
      },
    });
    await prisma.membershipConnectionScope.create({
      data: { businessId: a.businessId, membershipId: h.member.id, connectionId: second.id },
    });
    expect((await refreshDeferredIdentity(saved, a.businessId)).scope).toEqual({
      kind: "connections",
      connectionIds: [],
      customerProfileAccess: "none",
    });
    await prisma.membership.update({
      where: { id: h.member.id },
      data: { scopeMode: "workspace", customerProfileAccess: "write" },
    });
    expect((await refreshDeferredIdentity(saved, a.businessId)).scope).toEqual(saved.scope);
  });
  it("pins API key and original issuer membership identity, not just the same person", async () => {
    const { captureDeferredIdentity, refreshDeferredIdentity } = await api(),
      k = await key();
    const saved = await captureDeferredIdentity(k.ctx);
    expect(saved.origin).toMatchObject({
      kind: "api_key",
      apiKeyId: k.key.id,
      scopeOrigin: "issuer",
      issuerMembershipId: k.member.id,
    });
    await prisma.membership.delete({ where: { id: k.member.id } });
    await prisma.membership.create({
      data: { businessId: a.businessId, userId: a.ownerUserId, role: "owner" },
    });
    await expect(refreshDeferredIdentity(saved, a.businessId)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it("denies revoked/expired/inactive keys, issuer demotion/scope overflow and unclassified origin", async () => {
    const { captureDeferredIdentity, refreshDeferredIdentity } = await api(),
      k = await key();
    const saved = await captureDeferredIdentity(k.ctx);
    for (const changes of [
      { isActive: false },
      { revokedAt: new Date() },
      { expiresAt: new Date(Date.now() - 1) },
      { scopeOrigin: "unclassified" as const },
    ]) {
      await prisma.apiKey.update({ where: { id: k.key.id }, data: changes });
      await expect(refreshDeferredIdentity(saved, a.businessId)).rejects.toMatchObject({
        statusCode: 403,
      });
      await prisma.apiKey.update({
        where: { id: k.key.id },
        data: { isActive: true, revokedAt: null, expiresAt: null, scopeOrigin: "issuer" },
      });
    }
    await prisma.membership.update({ where: { id: k.member.id }, data: { role: "agent" } });
    await expect(refreshDeferredIdentity(saved, a.businessId)).rejects.toMatchObject({
      statusCode: 403,
    });
    await prisma.membership.update({
      where: { id: k.member.id },
      data: { role: "owner", scopeMode: "connections" },
    });
    await expect(refreshDeferredIdentity(saved, a.businessId)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it("supports explicitly classified legacy workspace keys without guessing or converting issuer origin", async () => {
    const { captureDeferredIdentity, refreshDeferredIdentity } = await api(),
      k = await key();
    await prisma.apiKey.update({
      where: { id: k.key.id },
      data: { scopeOrigin: "legacy_workspace", issuedByUserId: null },
    });
    const saved = await captureDeferredIdentity(k.ctx);
    expect(saved.origin).toEqual({
      kind: "api_key",
      apiKeyId: k.key.id,
      scopeOrigin: "legacy_workspace",
    });
    expect((await refreshDeferredIdentity(saved, a.businessId)).role).toBe("agent");
    await prisma.apiKey.update({
      where: { id: k.key.id },
      data: { scopeOrigin: "issuer", issuedByUserId: a.ownerUserId },
    });
    await expect(refreshDeferredIdentity(saved, a.businessId)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it("fails closed on missing/support/unknown origin, actor mismatch, foreign business and malformed snapshots", async () => {
    const { captureDeferredIdentity, refreshDeferredIdentity } = await api(),
      h = await human();
    for (const ctx of [
      { ...h.ctx, authorization: undefined },
      { ...h.ctx, resourceScope: undefined },
      {
        ...h.ctx,
        actor: { kind: "system_job" as const, jobId: "not-a-person", jobType: "send-followup" },
      },
      {
        ...h.ctx,
        actor: { kind: "channel_credential" as const, channelConnectionId: "not-a-person" },
      },
      {
        ...h.ctx,
        authorization: {
          kind: "support" as const,
          userId: a.ownerUserId,
          grantId: randomUUID(),
          allowedOperations: ["messages:create"],
        },
      },
      { ...h.ctx, actor: { kind: "user" as const, userId: b.ownerUserId } },
    ])
      await expect(captureDeferredIdentity(ctx)).rejects.toMatchObject({ statusCode: 403 });
    const saved = await captureDeferredIdentity(h.ctx);
    for (const input of [
      null,
      {},
      { ...saved, version: 99 },
      { ...saved, token: "must-not-store" },
      { ...saved, origin: { ...saved.origin, role: "owner" } },
      { ...saved, scope: { kind: "workspace", customerProfileAccess: "unknown" } },
    ])
      await expect(refreshDeferredIdentity(input, a.businessId)).rejects.toMatchObject({
        statusCode: 403,
      });
    await expect(refreshDeferredIdentity(saved, b.businessId)).rejects.toMatchObject({
      statusCode: 403,
    });
    await prisma.business.update({ where: { id: a.businessId }, data: { status: "suspended" } });
    await expect(refreshDeferredIdentity(saved, a.businessId)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe("deferred origin additional identity and profile ceilings", () => {
  it("preserves key-origin AI retag and rejects mismatched key actors, issuer substitution and classification conversion", async () => {
    const { captureDeferredIdentity, refreshDeferredIdentity } = await api(),
      k = await key();
    const saved = await captureDeferredIdentity({
      ...k.ctx,
      role: null,
      actor: { kind: "ai_agent", conversationId: "internal-chat", model: "stand-in" },
    });
    expect(saved.origin.kind).toBe("api_key");
    await expect(
      captureDeferredIdentity({ ...k.ctx, actor: { kind: "api_key", apiKeyId: randomUUID() } })
    ).rejects.toMatchObject({ statusCode: 403 });
    await prisma.membership.create({
      data: { businessId: a.businessId, userId: b.ownerUserId, role: "owner" },
    });
    await prisma.apiKey.update({
      where: { id: k.key.id },
      data: { issuedByUserId: b.ownerUserId },
    });
    await expect(refreshDeferredIdentity(saved, a.businessId)).rejects.toMatchObject({
      statusCode: 403,
    });
    await prisma.apiKey.update({
      where: { id: k.key.id },
      data: { issuedByUserId: null, scopeOrigin: "legacy_workspace" },
    });
    await expect(refreshDeferredIdentity(saved, a.businessId)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it("intersects profile capabilities and rejects malformed current scope or unknown current roles", async () => {
    const { captureDeferredIdentity, refreshDeferredIdentity } = await api(),
      h = await human();
    const saved = await captureDeferredIdentity({
      ...h.ctx,
      resourceScope: { kind: "workspace", customerProfileAccess: "read" },
    });
    expect((await refreshDeferredIdentity(saved, a.businessId)).scope.customerProfileAccess).toBe(
      "read"
    );
    await prisma.membership.update({
      where: { id: h.member.id },
      data: { customerProfileAccess: "none" },
    });
    expect((await refreshDeferredIdentity(saved, a.businessId)).scope.customerProfileAccess).toBe(
      "none"
    );
    expect((await captureDeferredIdentity(h.ctx)).scope.customerProfileAccess).toBe("none");
    await prisma.membership.update({
      where: { id: h.member.id },
      data: { customerProfileAccess: "write", scopeMode: "unclassified" },
    });
    await expect(refreshDeferredIdentity(saved, a.businessId)).rejects.toMatchObject({
      statusCode: 403,
    });
    await prisma.membership.update({
      where: { id: h.member.id },
      data: { scopeMode: "workspace", role: "unknown-future-role" },
    });
    await expect(refreshDeferredIdentity(saved, a.businessId)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});
