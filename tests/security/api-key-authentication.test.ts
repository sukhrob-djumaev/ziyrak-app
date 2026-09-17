import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §33.4 item 5 / §46.2 acceptance criteria — "ApiKeys resolve to
 * their own business and capped role via hash comparison, not global admin
 * and not plaintext comparison ... now exercised through the real
 * authentication path (Phase 1 only tested storage; this phase tests
 * authentication)." Also closes the task's explicit "API keys cannot cross
 * business boundaries" isolation requirement.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/route-auth", async (importOriginal) => importOriginal());

import { createRequest, parseJsonResponse } from "../helpers/request";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import * as apiKeysService from "@/lib/admin-api-keys/service";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

let businessA: SeededBusiness;
let businessB: SeededBusiness;
let fullKeyA: string;

beforeAll(async () => {
  businessA = await seedBusiness("apikey-auth-a");
  businessB = await seedBusiness("apikey-auth-b");
  const created = await apiKeysService.create(businessA.ctx, "test-key");
  fullKeyA = created.fullKey;
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

describe("API key authentication — real hash-compare path (§9.4/§33.4 item 5)", () => {
  it("resolves to the key's own business, not a hardcoded global admin", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const customerA = await dbA.customer.create({ data: { name: "A's customer" } });

    const { GET } = await import("@/app/api/customers/[id]/route");
    const request = createRequest(`/api/customers/${customerA.id}`, { headers: { "x-api-key": fullKeyA } });
    const response = await GET(request, { params: Promise.resolve({ id: customerA.id }) });
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.id).toBe(customerA.id);
  });

  it("cannot read another business's data even with a valid key (API keys cannot cross business boundaries)", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const customerB = await dbB.customer.create({ data: { name: "B's customer" } });

    const { GET } = await import("@/app/api/customers/[id]/route");
    const request = createRequest(`/api/customers/${customerB.id}`, { headers: { "x-api-key": fullKeyA } });
    const response = await GET(request, { params: Promise.resolve({ id: customerB.id }) });

    expect(response.status).toBe(404);
  });

  it("resolves the key's own capped role (agent), not admin — an owner-only action is rejected", async () => {
    const { GET } = await import("@/app/api/team/departments/route");
    // team:delete-equivalent is admin-only; use an admin:create-gated route
    // (admin API keys) to prove the resolved role is capped, not "admin".
    const { POST } = await import("@/app/api/admin/api-keys/route");
    const request = createRequest("/api/admin/api-keys", {
      method: "POST",
      headers: { "x-api-key": fullKeyA },
      body: { name: "should-be-forbidden" },
    });
    const response = await POST(request);
    expect(response.status).toBe(403);

    // Sanity: the same key CAN read team departments (agent-level read access).
    const readRequest = createRequest("/api/team/departments", { headers: { "x-api-key": fullKeyA } });
    const readResponse = await GET(readRequest);
    expect(readResponse.status).toBe(200);
  });

  it("rejects a well-formed but wrong key (never grants access on prefix match alone)", async () => {
    const wrongKey = fullKeyA.slice(0, -4) + "xxxx";
    const { GET } = await import("@/app/api/customers/route");
    const request = createRequest("/api/customers", { headers: { "x-api-key": wrongKey } });
    const response = await GET(request);
    expect(response.status).toBe(401);
  });

  it("cannot authenticate using the stored keyHash value as if it were the key (hash irreversibility, §33.4 item 5)", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const stored = await dbA.apiKey.findFirst({ where: { name: "test-key" } });

    const { GET } = await import("@/app/api/customers/route");
    const request = createRequest("/api/customers", { headers: { "x-api-key": stored!.keyHash } });
    const response = await GET(request);
    expect(response.status).toBe(401);
  });

  it("rejects a revoked key", async () => {
    const revoked = await apiKeysService.create(businessA.ctx, "revoked-key");
    const dbA = getScopedPrisma(businessA.ctx);
    await dbA.apiKey.update({ where: { id: revoked.apiKey.id }, data: { revokedAt: new Date() } });

    const { GET } = await import("@/app/api/customers/route");
    const request = createRequest("/api/customers", { headers: { "x-api-key": revoked.fullKey } });
    const response = await GET(request);
    expect(response.status).toBe(401);
  });
});
