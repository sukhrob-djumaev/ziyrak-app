import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
vi.mock("@/lib/identity/route-auth", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import * as scoped from "@/lib/tenancy/scoped-prisma";
import * as apiKeys from "@/lib/identity/admin-api-keys/service";
import { generateToken } from "@/lib/identity/auth";
import {
  seedBusiness,
  addMember,
  cleanupBusiness,
  type SeededBusiness,
} from "../helpers/tenant-fixtures";
import { createRequest } from "../helpers/request";
import { PUT, DELETE } from "@/app/api/admin/users/[id]/route";
import { POST } from "@/app/api/admin/users/route";
let a: SeededBusiness,
  b: SeededBusiness,
  adminId: string,
  targetId: string,
  targetMembership: string;
beforeAll(async () => {
  a = await seedBusiness("p1-team-a");
  b = await seedBusiness("p1-team-b");
  adminId = (await addMember(a.businessId, "admin", "workspace-admin")).userId;
  targetId = (await addMember(a.businessId, "agent", "shared-person")).userId;
  await prisma.membership.create({
    data: { businessId: b.businessId, userId: targetId, role: "admin" },
  });
  targetMembership = (
    await prisma.membership.findUniqueOrThrow({
      where: { businessId_userId: { businessId: a.businessId, userId: targetId } },
    })
  ).id;
});
afterAll(async () => {
  if (a) await cleanupBusiness(a.businessId);
  if (b) await cleanupBusiness(b.businessId);
});
function req(actor: string, id: string, body: object) {
  return createRequest(`/api/admin/users/${id}`, {
    method: "PUT",
    body,
    cookies: { "owly-token": generateToken(actor) },
  });
}
describe("workspace team authority (real route auth/Postgres)", () => {
  it("a restricted admin cannot provision a wider membership", async () => {
    const actor = await addMember(a.businessId, "admin", "restricted-provisioner");
    const conn = await prisma.channelConnection.create({
      data: {
        businessId: a.businessId,
        type: "webchat",
        name: "Restricted administration fixture",
      },
    });
    const membership = await prisma.membership.update({
      where: {
        businessId_userId: { businessId: a.businessId, userId: actor.userId },
      },
      data: { scopeMode: "connections", customerProfileAccess: "none" },
    });
    await prisma.membershipConnectionScope.create({
      data: {
        businessId: a.businessId,
        membershipId: membership.id,
        connectionId: conn.id,
      },
    });
    const email = `forbidden-wider-${crypto.randomUUID()}@example.test`;
    const response = await POST(
      createRequest("/api/admin/users", {
        method: "POST",
        cookies: { "owly-token": generateToken(actor.userId) },
        body: { email, role: "admin" },
      })
    );
    expect(response.status).toBe(403);
    expect(await prisma.accountToken.count({ where: { email } })).toBe(0);
    expect(
      (await prisma.membership.findUniqueOrThrow({ where: { id: membership.id } })).scopeMode
    ).toBe("connections");
  });
  it("denies admin promotion of a member to owner", async () => {
    const r = await PUT(req(adminId, targetMembership, { role: "owner" }), {
      params: Promise.resolve({ id: targetMembership }),
    });
    expect(r.status).toBe(403);
    expect(
      (await prisma.membership.findUniqueOrThrow({ where: { id: targetMembership } })).role
    ).toBe("agent");
  });
  it("denies ownership grant through generic owner team editing", async () => {
    const r = await PUT(req(a.ownerUserId, targetMembership, { role: "owner" }), {
      params: Promise.resolve({ id: targetMembership }),
    });
    expect(r.status).toBe(403);
  });
  it("cannot modify another workspace's shared identity or credentials, including compound updates", async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: targetId } });
    for (const actor of [adminId, a.ownerUserId]) {
      const r = await PUT(
        req(actor, targetMembership, {
          name: "Taken over",
          password: "different-test-password",
          role: "admin",
        }),
        { params: Promise.resolve({ id: targetMembership }) }
      );
      expect(r.status).toBe(403);
    }
    const after = await prisma.user.findUniqueOrThrow({ where: { id: targetId } });
    expect(after.name).toBe(before.name);
    expect(after.password).toBe(before.password);
    expect(
      (await prisma.membership.findUniqueOrThrow({ where: { id: targetMembership } })).role
    ).toBe("agent");
  });
  it("admin cannot demote or remove an owner even when another owner exists", async () => {
    const extra = (await addMember(a.businessId, "owner", "second-owner")).userId;
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { businessId_userId: { businessId: a.businessId, userId: extra } },
    });
    const r = await PUT(req(adminId, membership.id, { role: "viewer" }), {
      params: Promise.resolve({ id: membership.id }),
    });
    expect(r.status).toBe(403);
    const d = await DELETE(
      createRequest(`/api/admin/users/${membership.id}`, {
        method: "DELETE",
        cookies: { "owly-token": generateToken(adminId) },
      }),
      { params: Promise.resolve({ id: membership.id }) }
    );
    expect(d.status).toBe(403);
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: membership.id } })).role).toBe(
      "owner"
    );
  });
  it("denies actual API-key routes even if a stored key has an admin role", async () => {
    const key = await apiKeys.create(a.ctx, "synthetic-admin-key");
    await prisma.apiKey.update({ where: { id: key.apiKey.id }, data: { role: "admin" } });
    const options = { headers: { "x-api-key": key.fullKey } };
    const u = await PUT(
      createRequest(`/api/admin/users/${targetMembership}`, {
        ...options,
        method: "PUT",
        body: { role: "viewer" },
      }),
      { params: Promise.resolve({ id: targetMembership }) }
    );
    expect(u.status).toBe(401); // Higher-role keys are invalid at the identity boundary.
    const d = await DELETE(
      createRequest(`/api/admin/users/${targetMembership}`, { ...options, method: "DELETE" }),
      { params: Promise.resolve({ id: targetMembership }) }
    );
    expect(d.status).toBe(401);
  });
  it("never changes or removes a target promoted to owner after the authorization read", async () => {
    for (const method of ["update", "delete"] as const) {
      const target = (await addMember(a.businessId, "agent", "race-" + method)).userId;
      const row = await prisma.membership.findUniqueOrThrow({
        where: { businessId_userId: { businessId: a.businessId, userId: target } },
      });
      const original = scoped.getScopedPrisma;
      let injected = false;
      const spy = vi.spyOn(scoped, "getScopedPrisma").mockImplementation((ctx) => {
        const db = original(ctx);
        return new Proxy(db, {
          get(client, property, receiver) {
            if (property !== "membership") return Reflect.get(client, property, receiver);
            return new Proxy(db.membership, {
              get(delegate, key, delegateReceiver) {
                if (key !== "findUnique") return Reflect.get(delegate, key, delegateReceiver);
                return async (...args: Parameters<typeof delegate.findUnique>) => {
                  const found = await delegate.findUnique(...args);
                  if (!injected && found?.id === row.id) {
                    injected = true;
                    await prisma.membership.update({
                      where: { id: row.id },
                      data: { role: "owner" },
                    });
                  }
                  return found;
                };
              },
            });
          },
        });
      });
      try {
        const response =
          method === "update"
            ? await PUT(req(adminId, row.id, { role: "viewer" }), {
                params: Promise.resolve({ id: row.id }),
              })
            : await DELETE(
                createRequest(`/api/admin/users/${row.id}`, {
                  method: "DELETE",
                  cookies: { "owly-token": generateToken(adminId) },
                }),
                { params: Promise.resolve({ id: row.id }) }
              );
        expect(injected).toBe(true);
        expect([403, 404]).toContain(response.status);
        expect((await prisma.membership.findUniqueOrThrow({ where: { id: row.id } })).role).toBe(
          "owner"
        );
      } finally {
        spy.mockRestore();
      }
    }
  });
  it("permits legitimate non-owner role management and retains foreign-ID404", async () => {
    const r = await PUT(req(adminId, targetMembership, { role: "supervisor" }), {
      params: Promise.resolve({ id: targetMembership }),
    });
    expect(r.status).toBe(200);
    const foreign = await prisma.membership.findFirstOrThrow({
      where: { businessId: b.businessId, userId: targetId },
    });
    const f = await PUT(req(adminId, foreign.id, { role: "viewer" }), {
      params: Promise.resolve({ id: foreign.id }),
    });
    expect(f.status).toBe(404);
  });
});
