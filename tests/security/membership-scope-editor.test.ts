import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
vi.mock("@/lib/identity/route-auth", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { generateToken } from "@/lib/identity/auth";
import {
  seedBusiness,
  addMember,
  cleanupBusiness,
  type SeededBusiness,
} from "../helpers/tenant-fixtures";
import { createRequest } from "../helpers/request";
import { PUT } from "@/app/api/admin/users/[id]/route";

let a: SeededBusiness, b: SeededBusiness;
let adminId: string, targetUserId: string, targetMembership: string;
let connA1: string, connA2: string, connB: string;

async function membershipOf(businessId: string, userId: string) {
  return prisma.membership.findUniqueOrThrow({
    where: { businessId_userId: { businessId, userId } },
    include: { connectionScopes: true },
  });
}
async function put(actor: string, id: string, body: object) {
  return PUT(
    createRequest(`/api/admin/users/${id}`, {
      method: "PUT",
      body,
      cookies: { "owly-token": generateToken(actor) },
    }),
    { params: Promise.resolve({ id }) }
  );
}
async function reset() {
  await prisma.membershipConnectionScope.deleteMany({ where: { membershipId: targetMembership } });
  await prisma.membership.update({
    where: { id: targetMembership },
    data: { scopeMode: "workspace", customerProfileAccess: "write", role: "agent" },
  });
}

beforeAll(async () => {
  a = await seedBusiness("p1-scope-a");
  b = await seedBusiness("p1-scope-b");
  adminId = (await addMember(a.businessId, "admin", "scope-admin")).userId;
  targetUserId = (await addMember(a.businessId, "agent", "scope-target")).userId;
  targetMembership = (await membershipOf(a.businessId, targetUserId)).id;
  const mk = (businessId: string, name: string) =>
    prisma.channelConnection.create({ data: { businessId, type: "webchat", name } });
  connA1 = (await mk(a.businessId, "scope-a1")).id;
  connA2 = (await mk(a.businessId, "scope-a2")).id;
  connB = (await mk(b.businessId, "scope-b1")).id;
});
afterAll(async () => {
  if (a) await cleanupBusiness(a.businessId);
  if (b) await cleanupBusiness(b.businessId);
});

describe("membership scope editor (real route auth/Postgres)", () => {
  it("owner restricts a member to chosen connections with no profile access", async () => {
    await reset();
    const r = await put(a.ownerUserId, targetMembership, {
      scope: { kind: "connections", connectionIds: [connA1], customerProfileAccess: "none" },
    });
    expect(r.status).toBe(200);
    const m = await membershipOf(a.businessId, targetUserId);
    expect(m.scopeMode).toBe("connections");
    expect(m.customerProfileAccess).toBe("none");
    expect(m.connectionScopes.map((s) => s.connectionId)).toEqual([connA1]);
  });
  it("replaces the connection set and can widen back to the whole workspace", async () => {
    await reset();
    await put(a.ownerUserId, targetMembership, {
      scope: { kind: "connections", connectionIds: [connA1], customerProfileAccess: "read" },
    });
    await put(a.ownerUserId, targetMembership, {
      scope: { kind: "connections", connectionIds: [connA2], customerProfileAccess: "read" },
    });
    expect(
      (await membershipOf(a.businessId, targetUserId)).connectionScopes.map((s) => s.connectionId)
    ).toEqual([connA2]);
    const r = await put(a.ownerUserId, targetMembership, {
      scope: { kind: "workspace", customerProfileAccess: "write" },
    });
    expect(r.status).toBe(200);
    const m = await membershipOf(a.businessId, targetUserId);
    expect(m.scopeMode).toBe("workspace");
    expect(m.connectionScopes).toHaveLength(0);
  });
  it("rejects another workspace's connection, unknown ids, empty sets and unknown kinds without changing anything", async () => {
    await reset();
    for (const scope of [
      { kind: "connections", connectionIds: [connB], customerProfileAccess: "none" },
      { kind: "connections", connectionIds: [connA1, "00000000-0000-4000-8000-000000000000"] },
      { kind: "connections", connectionIds: [] },
      { kind: "unclassified" },
      { kind: "workspace", customerProfileAccess: "admin" },
      { kind: "workspace", connectionIds: [connA1] },
      "workspace",
    ]) {
      const r = await put(a.ownerUserId, targetMembership, { scope });
      expect(r.status, JSON.stringify(scope)).toBe(400);
    }
    const m = await membershipOf(a.businessId, targetUserId);
    expect(m.scopeMode).toBe("workspace");
    expect(m.customerProfileAccess).toBe("write");
    expect(m.connectionScopes).toHaveLength(0);
  });
  it("a compound request is all-or-nothing", async () => {
    await reset();
    const r = await put(a.ownerUserId, targetMembership, {
      role: "admin",
      scope: { kind: "connections", connectionIds: [connB] },
    });
    expect(r.status).toBe(400);
    expect((await membershipOf(a.businessId, targetUserId)).role).toBe("agent");
  });
  it("nobody edits their own scope, and an owner's scope cannot be restricted", async () => {
    await reset();
    const own = await membershipOf(a.businessId, adminId);
    expect(
      (
        await put(adminId, own.id, {
          scope: { kind: "connections", connectionIds: [connA1] },
        })
      ).status
    ).toBe(403);
    const owner = await membershipOf(a.businessId, a.ownerUserId);
    expect(
      (
        await put(a.ownerUserId, owner.id, {
          scope: { kind: "connections", connectionIds: [connA1] },
        })
      ).status
    ).toBe(403);
    expect((await membershipOf(a.businessId, a.ownerUserId)).scopeMode).toBe("workspace");
  });
  it("a connection-restricted admin cannot edit scopes (no widening or lateral grants)", async () => {
    await reset();
    const actor = await addMember(a.businessId, "admin", "scope-restricted-admin");
    const m = await membershipOf(a.businessId, actor.userId);
    await prisma.membership.update({
      where: { id: m.id },
      data: { scopeMode: "connections", customerProfileAccess: "none" },
    });
    await prisma.membershipConnectionScope.create({
      data: { businessId: a.businessId, membershipId: m.id, connectionId: connA1 },
    });
    const r = await put(actor.userId, targetMembership, {
      scope: { kind: "workspace", customerProfileAccess: "write" },
    });
    expect(r.status).toBe(403);
  });
  it("roles below admin and cross-workspace actors cannot edit scopes", async () => {
    await reset();
    const agent = await addMember(a.businessId, "agent", "scope-agent-actor");
    expect(
      (
        await put(agent.userId, targetMembership, {
          scope: { kind: "connections", connectionIds: [connA1] },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await put(b.ownerUserId, targetMembership, {
          scope: { kind: "connections", connectionIds: [connB] },
        })
      ).status
    ).toBeGreaterThanOrEqual(403);
    expect((await membershipOf(a.businessId, targetUserId)).scopeMode).toBe("workspace");
  });
  it("deleting a scoped connection leaves the member restricted, never silently widened", async () => {
    await reset();
    const solo = await prisma.channelConnection.create({
      data: { businessId: a.businessId, type: "webchat", name: "scope-solo" },
    });
    await put(a.ownerUserId, targetMembership, {
      scope: { kind: "connections", connectionIds: [solo.id] },
    });
    await prisma.channelConnection.delete({ where: { id: solo.id } });
    const m = await membershipOf(a.businessId, targetUserId);
    expect(m.scopeMode).toBe("connections");
    expect(m.connectionScopes).toHaveLength(0);
  });
});
