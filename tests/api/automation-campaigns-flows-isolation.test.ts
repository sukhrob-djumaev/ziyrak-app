import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §33.1 — tenant isolation matrix for "automation" (rules),
 * "campaigns", and "flows" — grouped in one file since PLAN.md's own
 * Phase 2 batch ordering (§46.2 task 8) groups them as one batch.
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
  businessA = await seedBusiness("acf-isolation-a");
  businessB = await seedBusiness("acf-isolation-b");
  tokenA = generateToken(businessA.ownerUserId);
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

function authedRequest(path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": tokenA, ...options.cookies } });
}

describe("tenant isolation: automation rules (§33.1)", () => {
  it("Business A cannot list, update, or delete Business B's automation rule", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const ruleB = await dbB.automationRule.create({
      data: { name: "B-rule", type: "auto_tag", conditions: [], actions: [] },
    });

    const { GET } = await import("@/app/api/automation/route");
    const listResponse = await GET(authedRequest("/api/automation", { searchParams: { limit: "200" } }));
    const listData = await parseJsonResponse(listResponse);
    expect(listData.data.map((r: { id: string }) => r.id)).not.toContain(ruleB.id);

    const { PUT, DELETE } = await import("@/app/api/automation/[id]/route");
    const putResponse = await PUT(
      authedRequest(`/api/automation/${ruleB.id}`, { method: "PUT", body: { name: "hacked" } }),
      { params: Promise.resolve({ id: ruleB.id }) }
    );
    expect(putResponse.status).toBe(404);

    const deleteResponse = await DELETE(authedRequest(`/api/automation/${ruleB.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: ruleB.id }),
    });
    expect(deleteResponse.status).toBe(404);

    expect((await dbB.automationRule.findUnique({ where: { id: ruleB.id } }))?.name).toBe("B-rule");
  });
});

describe("tenant isolation: campaigns (§33.1)", () => {
  it("Business A cannot list, fetch, update, or delete Business B's campaign", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const campaignB = await dbB.campaign.create({ data: { name: "B-campaign", message: "hi" } });

    const { GET } = await import("@/app/api/campaigns/route");
    const listResponse = await GET(authedRequest("/api/campaigns", { searchParams: { limit: "200" } }));
    const listData = await parseJsonResponse(listResponse);
    expect(listData.data.map((c: { id: string }) => c.id)).not.toContain(campaignB.id);

    const { GET: GetOne, PUT, DELETE } = await import("@/app/api/campaigns/[id]/route");

    const getResponse = await GetOne(authedRequest(`/api/campaigns/${campaignB.id}`), {
      params: Promise.resolve({ id: campaignB.id }),
    });
    expect(getResponse.status).toBe(404);

    const putResponse = await PUT(
      authedRequest(`/api/campaigns/${campaignB.id}`, { method: "PUT", body: { name: "hacked" } }),
      { params: Promise.resolve({ id: campaignB.id }) }
    );
    expect(putResponse.status).toBe(404);

    const deleteResponse = await DELETE(authedRequest(`/api/campaigns/${campaignB.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: campaignB.id }),
    });
    expect(deleteResponse.status).toBe(404);

    expect((await dbB.campaign.findUnique({ where: { id: campaignB.id } }))?.name).toBe("B-campaign");
  });

  it("Business A cannot execute Business B's campaign via a known id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const campaignB = await dbB.campaign.create({ data: { name: "B-exec", message: "hi", segments: [] } });

    const { POST } = await import("@/app/api/campaigns/[id]/execute/route");
    const response = await POST(authedRequest(`/api/campaigns/${campaignB.id}/execute`, { method: "POST" }), {
      params: Promise.resolve({ id: campaignB.id }),
    });

    expect(response.status).toBe(404);
  });
});

describe("tenant isolation: flows (§33.1)", () => {
  it("Business A cannot list, fetch, update, or delete Business B's flow", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const flowB = await dbB.flow.create({ data: { name: "B-flow" } });

    const { GET } = await import("@/app/api/flows/route");
    const listResponse = await GET(authedRequest("/api/flows", { searchParams: { limit: "200" } }));
    const listData = await parseJsonResponse(listResponse);
    expect(listData.data.map((f: { id: string }) => f.id)).not.toContain(flowB.id);

    const { GET: GetOne, PUT, DELETE } = await import("@/app/api/flows/[id]/route");

    const getResponse = await GetOne(authedRequest(`/api/flows/${flowB.id}`), {
      params: Promise.resolve({ id: flowB.id }),
    });
    expect(getResponse.status).toBe(404);

    const putResponse = await PUT(
      authedRequest(`/api/flows/${flowB.id}`, { method: "PUT", body: { name: "hacked" } }),
      { params: Promise.resolve({ id: flowB.id }) }
    );
    expect(putResponse.status).toBe(404);

    const deleteResponse = await DELETE(authedRequest(`/api/flows/${flowB.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: flowB.id }),
    });
    expect(deleteResponse.status).toBe(404);

    expect((await dbB.flow.findUnique({ where: { id: flowB.id } }))?.name).toBe("B-flow");
  });

  it("Business A cannot validate Business B's flow via a known id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const flowB = await dbB.flow.create({ data: { name: "B-validate" } });

    const { POST } = await import("@/app/api/flows/[id]/validate/route");
    const response = await POST(authedRequest(`/api/flows/${flowB.id}/validate`, { method: "POST" }), {
      params: Promise.resolve({ id: flowB.id }),
    });

    expect(response.status).toBe(404);
  });
});
