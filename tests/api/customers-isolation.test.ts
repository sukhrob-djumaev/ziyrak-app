import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §33.1 — the standard tenant-isolation test shape, applied to the
 * "customers" module (the first batch converted per §46.2 task 8's
 * ordering). Real Postgres + real auth resolution, matching
 * tests/security/auth-bypass-regression.test.ts's unmock pattern — the
 * default global mocks in tests/setup.ts would hide exactly the class of
 * bug this suite exists to catch.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/route-auth", async (importOriginal) => importOriginal());

import { generateToken } from "@/lib/auth";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

let businessA: SeededBusiness;
let businessB: SeededBusiness;
let tokenA: string;

beforeAll(async () => {
  businessA = await seedBusiness("customers-isolation-a");
  businessB = await seedBusiness("customers-isolation-b");
  tokenA = generateToken(businessA.ownerUserId);
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

function authedRequest(path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": tokenA, ...options.cookies } });
}

describe("tenant isolation: customers (§33.1)", () => {
  it("Business A cannot list Business B's customers", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const customerB = await dbB.customer.create({ data: { name: "B-only customer" } });

    const { GET } = await import("@/app/api/customers/route");
    const response = await GET(authedRequest("/api/customers", { searchParams: { limit: "200" } }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data.map((c: { id: string }) => c.id)).not.toContain(customerB.id);
  });

  it("Business A cannot fetch Business B's customer by known id (404, not 403 — §33.3)", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const customerB = await dbB.customer.create({ data: { name: "B-fetch-target" } });

    const { GET } = await import("@/app/api/customers/[id]/route");
    const response = await GET(authedRequest(`/api/customers/${customerB.id}`), {
      params: Promise.resolve({ id: customerB.id }),
    });

    expect(response.status).toBe(404);
  });

  it("Business A cannot update Business B's customer by known id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const customerB = await dbB.customer.create({ data: { name: "B-update-target" } });

    const { PUT } = await import("@/app/api/customers/[id]/route");
    const response = await PUT(
      authedRequest(`/api/customers/${customerB.id}`, { method: "PUT", body: { name: "hacked" } }),
      { params: Promise.resolve({ id: customerB.id }) }
    );

    expect(response.status).toBe(404);

    const stillIntact = await dbB.customer.findUnique({ where: { id: customerB.id } });
    expect(stillIntact?.name).toBe("B-update-target");
  });

  it("Business A cannot delete Business B's customer by known id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const customerB = await dbB.customer.create({ data: { name: "B-delete-target" } });

    const { DELETE } = await import("@/app/api/customers/[id]/route");
    const response = await DELETE(authedRequest(`/api/customers/${customerB.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: customerB.id }),
    });

    expect(response.status).toBe(404);

    const stillExists = await dbB.customer.findUnique({ where: { id: customerB.id } });
    expect(stillExists).not.toBeNull();
  });

  it("Business A cannot read Business B's customer notes via a known customer id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const customerB = await dbB.customer.create({ data: { name: "B-notes-target" } });
    await dbB.customerNote.create({ data: { customerId: customerB.id, content: "secret note" } });

    const { GET } = await import("@/app/api/customers/[id]/notes/route");
    const response = await GET(authedRequest(`/api/customers/${customerB.id}/notes`), {
      params: Promise.resolve({ id: customerB.id }),
    });

    expect(response.status).toBe(404);
  });

  it("Business A cannot add a note to Business B's customer via a known customer id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const customerB = await dbB.customer.create({ data: { name: "B-add-note-target" } });

    const { POST } = await import("@/app/api/customers/[id]/notes/route");
    const response = await POST(
      authedRequest(`/api/customers/${customerB.id}/notes`, { method: "POST", body: { content: "injected" } }),
      { params: Promise.resolve({ id: customerB.id }) }
    );

    expect(response.status).toBe(404);

    const notes = await dbB.customerNote.findMany({ where: { customerId: customerB.id } });
    expect(notes.some((n) => n.content === "injected")).toBe(false);
  });

  it("Business A cannot list Business B's customer's conversations via a known customer id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const customerB = await dbB.customer.create({ data: { name: "B-conv-target" } });

    const { GET } = await import("@/app/api/customers/[id]/conversations/route");
    const response = await GET(authedRequest(`/api/customers/${customerB.id}/conversations`), {
      params: Promise.resolve({ id: customerB.id }),
    });

    expect(response.status).toBe(404);
  });

  it("Business A's own customer is fully reachable (positive control)", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const customerA = await dbA.customer.create({ data: { name: "A-own-customer" } });

    const { GET } = await import("@/app/api/customers/[id]/route");
    const response = await GET(authedRequest(`/api/customers/${customerA.id}`), {
      params: Promise.resolve({ id: customerA.id }),
    });
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.id).toBe(customerA.id);
  });
});
