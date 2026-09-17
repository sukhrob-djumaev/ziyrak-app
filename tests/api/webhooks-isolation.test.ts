import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §33.1 — tenant isolation matrix for "webhooks" (+ deliveries),
 * including §8.4's WebhookDelivery.webhookId composite FK relation.
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
  businessA = await seedBusiness("webhooks-isolation-a");
  businessB = await seedBusiness("webhooks-isolation-b");
  tokenA = generateToken(businessA.ownerUserId);
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

function authedRequest(path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": tokenA, ...options.cookies } });
}

describe("tenant isolation: webhooks (§33.1)", () => {
  it("Business A cannot list Business B's webhooks", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const whB = await dbB.webhook.create({
      data: { name: "B-only", url: "https://example.com/b", triggerOn: "ticket_created" },
    });

    const { GET } = await import("@/app/api/webhooks/route");
    const response = await GET(authedRequest("/api/webhooks", { searchParams: { limit: "200" } }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data.map((w: { id: string }) => w.id)).not.toContain(whB.id);
  });

  it("Business A cannot fetch, update, or delete Business B's webhook by known id (404)", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const whB = await dbB.webhook.create({
      data: { name: "B-target", url: "https://example.com/b2", triggerOn: "ticket_created" },
    });

    const { GET, PUT, DELETE } = await import("@/app/api/webhooks/[id]/route");

    const getResponse = await GET(authedRequest(`/api/webhooks/${whB.id}`), {
      params: Promise.resolve({ id: whB.id }),
    });
    expect(getResponse.status).toBe(404);

    const putResponse = await PUT(
      authedRequest(`/api/webhooks/${whB.id}`, { method: "PUT", body: { name: "hacked" } }),
      { params: Promise.resolve({ id: whB.id }) }
    );
    expect(putResponse.status).toBe(404);

    const deleteResponse = await DELETE(authedRequest(`/api/webhooks/${whB.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: whB.id }),
    });
    expect(deleteResponse.status).toBe(404);

    expect((await dbB.webhook.findUnique({ where: { id: whB.id } }))?.name).toBe("B-target");
  });

  it("Business A cannot read Business B's webhook deliveries via a known webhook id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const whB = await dbB.webhook.create({
      data: { name: "B-deliveries", url: "https://example.com/b3", triggerOn: "ticket_created" },
    });
    await dbB.webhookDelivery.create({ data: { webhookId: whB.id, event: "test", payload: {} } });

    const { GET } = await import("@/app/api/webhooks/[id]/deliveries/route");
    const response = await GET(authedRequest(`/api/webhooks/${whB.id}/deliveries`), {
      params: Promise.resolve({ id: whB.id }),
    });

    expect(response.status).toBe(404);
  });

  it("Business A cannot retry a delivery belonging to Business B's webhook via a known id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const whB = await dbB.webhook.create({
      data: { name: "B-retry", url: "https://example.com/b4", triggerOn: "ticket_created" },
    });
    const deliveryB = await dbB.webhookDelivery.create({
      data: { webhookId: whB.id, event: "test", payload: {}, status: "failed" },
    });

    const { POST } = await import("@/app/api/webhooks/[id]/deliveries/route");
    const response = await POST(
      authedRequest(`/api/webhooks/${whB.id}/deliveries`, {
        method: "POST",
        body: { deliveryId: deliveryB.id },
      }),
      { params: Promise.resolve({ id: whB.id }) }
    );

    expect(response.status).toBe(404);
  });

  it("Business A's own webhook is fully reachable (positive control)", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const whA = await dbA.webhook.create({
      data: { name: "A-own", url: "https://example.com/a", triggerOn: "ticket_created" },
    });

    const { GET } = await import("@/app/api/webhooks/[id]/route");
    const response = await GET(authedRequest(`/api/webhooks/${whA.id}`), {
      params: Promise.resolve({ id: whA.id }),
    });
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.id).toBe(whA.id);
  });
});
