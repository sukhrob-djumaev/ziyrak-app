import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §33.1 — tenant isolation matrix for "knowledge" (categories +
 * entries), including §8.5's assertSameTenant() check on
 * KnowledgeEntry.categoryId.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { generateToken } from "@/lib/identity/auth";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

let businessA: SeededBusiness;
let businessB: SeededBusiness;
let tokenA: string;

beforeAll(async () => {
  businessA = await seedBusiness("knowledge-isolation-a");
  businessB = await seedBusiness("knowledge-isolation-b");
  tokenA = generateToken(businessA.ownerUserId);
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

function authedRequest(path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": tokenA, ...options.cookies } });
}

describe("tenant isolation: knowledge categories (§33.1)", () => {
  it("Business A cannot list Business B's categories", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const catB = await dbB.category.create({ data: { name: "B-only" } });

    const { GET } = await import("@/app/api/knowledge/categories/route");
    const response = await GET(authedRequest("/api/knowledge/categories", { searchParams: { limit: "200" } }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data.map((c: { id: string }) => c.id)).not.toContain(catB.id);
  });

  it("Business A cannot update or delete Business B's category by known id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const catB = await dbB.category.create({ data: { name: "B-target" } });

    const { PUT, DELETE } = await import("@/app/api/knowledge/categories/[id]/route");

    const putResponse = await PUT(
      authedRequest(`/api/knowledge/categories/${catB.id}`, { method: "PUT", body: { name: "hacked" } }),
      { params: Promise.resolve({ id: catB.id }) }
    );
    expect(putResponse.status).toBe(404);

    const deleteResponse = await DELETE(
      authedRequest(`/api/knowledge/categories/${catB.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: catB.id }) }
    );
    expect(deleteResponse.status).toBe(404);

    const stillExists = await dbB.category.findUnique({ where: { id: catB.id } });
    expect(stillExists?.name).toBe("B-target");
  });
});

describe("tenant isolation: knowledge entries (§33.1/§8.5)", () => {
  it("Business A cannot list Business B's entries", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const catB = await dbB.category.create({ data: { name: "B-cat" } });
    const entryB = await dbB.knowledgeEntry.create({ data: { categoryId: catB.id, title: "B-entry", content: "x" } });

    const { GET } = await import("@/app/api/knowledge/entries/route");
    const response = await GET(authedRequest("/api/knowledge/entries", { searchParams: { limit: "200" } }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data.map((e: { id: string }) => e.id)).not.toContain(entryB.id);
  });

  it("Business A cannot create an entry referencing Business B's Category (application layer, §8.5)", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const catB = await dbB.category.create({ data: { name: "B-cat2" } });

    const { POST } = await import("@/app/api/knowledge/entries/route");
    const response = await POST(
      authedRequest("/api/knowledge/entries", {
        method: "POST",
        body: { categoryId: catB.id, title: "cross-tenant attempt", content: "x" },
      })
    );

    expect(response.status).toBe(404);

    const dbA = getScopedPrisma(businessA.ctx);
    const leaked = await dbA.knowledgeEntry.findFirst({ where: { categoryId: catB.id } });
    expect(leaked).toBeNull();
  });

  it("Business A cannot update its own entry to reference Business B's Category", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);
    const catA = await dbA.category.create({ data: { name: "A-cat" } });
    const entryA = await dbA.knowledgeEntry.create({ data: { categoryId: catA.id, title: "A-entry", content: "x" } });
    const catB = await dbB.category.create({ data: { name: "B-cat3" } });

    const { PUT } = await import("@/app/api/knowledge/entries/[id]/route");
    const response = await PUT(
      authedRequest(`/api/knowledge/entries/${entryA.id}`, { method: "PUT", body: { categoryId: catB.id } }),
      { params: Promise.resolve({ id: entryA.id }) }
    );

    expect(response.status).toBe(404);
    const unchanged = await dbA.knowledgeEntry.findUnique({ where: { id: entryA.id } });
    expect(unchanged?.categoryId).toBe(catA.id);
  });

  it("Business A cannot update or delete Business B's entry by known id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const catB = await dbB.category.create({ data: { name: "B-cat4" } });
    const entryB = await dbB.knowledgeEntry.create({ data: { categoryId: catB.id, title: "B-entry2", content: "x" } });

    const { PUT, DELETE } = await import("@/app/api/knowledge/entries/[id]/route");

    const putResponse = await PUT(
      authedRequest(`/api/knowledge/entries/${entryB.id}`, { method: "PUT", body: { title: "hacked" } }),
      { params: Promise.resolve({ id: entryB.id }) }
    );
    expect(putResponse.status).toBe(404);

    const deleteResponse = await DELETE(
      authedRequest(`/api/knowledge/entries/${entryB.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: entryB.id }) }
    );
    expect(deleteResponse.status).toBe(404);

    expect(await dbB.knowledgeEntry.findUnique({ where: { id: entryB.id } })).not.toBeNull();
  });
});
