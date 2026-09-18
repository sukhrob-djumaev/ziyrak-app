import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §33.1 — tenant isolation for the remaining routes not named in
 * §46.2 task 8's 8 batches but still covered by "every route handler" in
 * the phase's acceptance criteria: activity, analytics, sla,
 * canned-responses, stats, export.
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
  businessA = await seedBusiness("misc-isolation-a");
  businessB = await seedBusiness("misc-isolation-b");
  tokenA = generateToken(businessA.ownerUserId);
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

function authedRequest(path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": tokenA, ...options.cookies } });
}

describe("tenant isolation: activity (§33.1)", () => {
  it("Business A never sees Business B's activity log entries", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    await dbB.activityLog.create({ data: { action: "b.action", entity: "test", description: "B only" } });

    const { GET } = await import("@/app/api/activity/route");
    const response = await GET(authedRequest("/api/activity", { searchParams: { limit: "500" } }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data.every((a: { description: string }) => a.description !== "B only")).toBe(true);
  });
});

describe("tenant isolation: sla (§33.1)", () => {
  it("Business A cannot list, update, or delete Business B's SLA rule", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const ruleB = await dbB.sLARule.create({ data: { name: "B-sla" } });

    const { GET } = await import("@/app/api/sla/route");
    const listResponse = await GET(authedRequest("/api/sla", { searchParams: { limit: "200" } }));
    const listData = await parseJsonResponse(listResponse);
    expect(listData.data.map((r: { id: string }) => r.id)).not.toContain(ruleB.id);

    const { PUT, DELETE } = await import("@/app/api/sla/[id]/route");
    const putResponse = await PUT(
      authedRequest(`/api/sla/${ruleB.id}`, { method: "PUT", body: { name: "hacked" } }),
      { params: Promise.resolve({ id: ruleB.id }) }
    );
    expect(putResponse.status).toBe(404);

    const deleteResponse = await DELETE(authedRequest(`/api/sla/${ruleB.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: ruleB.id }),
    });
    expect(deleteResponse.status).toBe(404);

    expect((await dbB.sLARule.findUnique({ where: { id: ruleB.id } }))?.name).toBe("B-sla");
  });
});

describe("tenant isolation: canned-responses (§33.1)", () => {
  it("Business A cannot list, update, or delete Business B's canned response", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const responseB = await dbB.cannedResponse.create({ data: { title: "B-canned", content: "x" } });

    const { GET } = await import("@/app/api/canned-responses/route");
    const listResponse = await GET(authedRequest("/api/canned-responses", { searchParams: { limit: "200" } }));
    const listData = await parseJsonResponse(listResponse);
    expect(listData.data.map((r: { id: string }) => r.id)).not.toContain(responseB.id);

    const { PUT, DELETE } = await import("@/app/api/canned-responses/[id]/route");
    const putResponse = await PUT(
      authedRequest(`/api/canned-responses/${responseB.id}`, { method: "PUT", body: { title: "hacked" } }),
      { params: Promise.resolve({ id: responseB.id }) }
    );
    expect(putResponse.status).toBe(404);

    const deleteResponse = await DELETE(
      authedRequest(`/api/canned-responses/${responseB.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: responseB.id }) }
    );
    expect(deleteResponse.status).toBe(404);

    expect((await dbB.cannedResponse.findUnique({ where: { id: responseB.id } }))?.title).toBe("B-canned");
  });
});

describe("tenant isolation: analytics/stats/export (§33.1)", () => {
  it("analytics never aggregates Business B's conversations into Business A's numbers", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    for (let i = 0; i < 5; i++) {
      await dbB.conversation.create({ data: { channel: "whatsapp" } });
    }

    const { GET } = await import("@/app/api/analytics/route");
    const response = await GET(authedRequest("/api/analytics", { searchParams: { period: "90d" } }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.totalConversations).toBe(0);
  });

  it("stats never aggregates Business B's conversations into Business A's numbers", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    await dbB.conversation.create({ data: { channel: "whatsapp" } });

    const { GET } = await import("@/app/api/stats/route");
    const response = await GET(authedRequest("/api/stats"));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.totalConversations).toBe(0);
  });

  it("export never includes Business B's rows", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const convB = await dbB.conversation.create({ data: { channel: "whatsapp", customerName: "B-export" } });

    const { GET } = await import("@/app/api/export/route");
    const response = await GET(authedRequest("/api/export", { searchParams: { type: "conversations", format: "json" } }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data.map((c: { id: string }) => c.id)).not.toContain(convB.id);
  });
});
