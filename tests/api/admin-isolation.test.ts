import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §33.1 — tenant isolation matrix for "admin" (team members via
 * Membership, API keys) and "business-hours", completing the
 * "admin/settings" batch (§46.2 task 8).
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { generateToken } from "@/lib/identity/auth";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { seedBusiness, addMember, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

let businessA: SeededBusiness;
let businessB: SeededBusiness;
let tokenA: string;

beforeAll(async () => {
  businessA = await seedBusiness("admin-isolation-a");
  businessB = await seedBusiness("admin-isolation-b");
  tokenA = generateToken(businessA.ownerUserId);
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

function authedRequest(path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": tokenA, ...options.cookies } });
}

describe("tenant isolation: admin/users (§33.1)", () => {
  it("Business A cannot see Business B's team members in the list", async () => {
    const memberB = await addMember(businessB.businessId, "agent", "b-member");

    const { GET } = await import("@/app/api/admin/users/route");
    const response = await GET(authedRequest("/api/admin/users", { searchParams: { limit: "200" } }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data.map((u: { userId: string }) => u.userId)).not.toContain(memberB.userId);
  });

  it("Business A cannot update or remove Business B's membership by known id", async () => {
    const memberB = await addMember(businessB.businessId, "agent", "b-target");
    const dbB = getScopedPrisma(businessB.ctx);
    const membershipB = await dbB.membership.findFirst({ where: { userId: memberB.userId } });

    const { PUT, DELETE } = await import("@/app/api/admin/users/[id]/route");

    const putResponse = await PUT(
      authedRequest(`/api/admin/users/${membershipB!.id}`, { method: "PUT", body: { role: "admin" } }),
      { params: Promise.resolve({ id: membershipB!.id }) }
    );
    expect(putResponse.status).toBe(404);

    const deleteResponse = await DELETE(
      authedRequest(`/api/admin/users/${membershipB!.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: membershipB!.id }) }
    );
    expect(deleteResponse.status).toBe(404);

    const stillExists = await dbB.membership.findUnique({ where: { id: membershipB!.id } });
    expect(stillExists?.role).toBe("agent");
  });
});

describe("tenant isolation: admin/api-keys (§33.1)", () => {
  it("Business A cannot list Business B's API keys", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const keyB = await dbB.apiKey.create({ data: { name: "B-key", keyPrefix: "zy_live_bbbbbbbb", keyHash: "hash-b" } });

    const { GET } = await import("@/app/api/admin/api-keys/route");
    const response = await GET(authedRequest("/api/admin/api-keys", { searchParams: { limit: "200" } }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data.map((k: { id: string }) => k.id)).not.toContain(keyB.id);
  });

  it("Business A cannot update or delete Business B's API key by known id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const keyB = await dbB.apiKey.create({ data: { name: "B-target-key", keyPrefix: "zy_live_ccccccccc", keyHash: "hash-c" } });

    const { PUT, DELETE } = await import("@/app/api/admin/api-keys/[id]/route");

    const putResponse = await PUT(
      authedRequest(`/api/admin/api-keys/${keyB.id}`, { method: "PUT", body: { isActive: false } }),
      { params: Promise.resolve({ id: keyB.id }) }
    );
    expect(putResponse.status).toBe(404);

    const deleteResponse = await DELETE(
      authedRequest(`/api/admin/api-keys/${keyB.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: keyB.id }) }
    );
    expect(deleteResponse.status).toBe(404);

    const stillActive = await dbB.apiKey.findUnique({ where: { id: keyB.id } });
    expect(stillActive?.isActive).toBe(true);
  });
});

describe("tenant isolation: business-hours (§33.1)", () => {
  it("Business A's business-hours GET/PUT never touches Business B's row", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    await dbB.businessHours.create({
      data: { id: "bh-b-scratch", businessId: businessB.businessId, enabled: true, offlineMessage: "B message" },
    });

    const { GET, PUT } = await import("@/app/api/business-hours/route");

    const getResponse = await GET(authedRequest("/api/business-hours"));
    const getData = await parseJsonResponse(getResponse);
    expect(getData.businessId).toBe(businessA.businessId);
    expect(getData.offlineMessage).not.toBe("B message");

    const putResponse = await PUT(
      authedRequest("/api/business-hours", { method: "PUT", body: { offlineMessage: "A message" } })
    );
    const putData = await parseJsonResponse(putResponse);
    expect(putData.businessId).toBe(businessA.businessId);

    const bUnchanged = await dbB.businessHours.findUnique({ where: { businessId: businessB.businessId } });
    expect(bUnchanged?.offlineMessage).toBe("B message");
  });
});
