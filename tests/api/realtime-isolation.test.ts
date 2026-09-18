import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §26.2/§33.2/§46.2 acceptance criteria — "Realtime subscriptions
 * are rejected for conversations outside the caller's business." A client
 * only ever names a relative channel ("global" or "conversation:<id>");
 * the tenant-prefixed channel is always constructed server-side from
 * ctx.businessId, and a conversation subscription is only honored once
 * confirmed (via the tenant-scoped Prisma client) to belong to the
 * caller's own business.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { generateToken } from "@/lib/identity/auth";
import { createRequest } from "../helpers/request";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

let businessA: SeededBusiness;
let businessB: SeededBusiness;
let tokenA: string;

beforeAll(async () => {
  businessA = await seedBusiness("realtime-isolation-a");
  businessB = await seedBusiness("realtime-isolation-b");
  tokenA = generateToken(businessA.ownerUserId);
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

function authedRequest(path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": tokenA, ...options.cookies } });
}

describe("tenant isolation: realtime subscriptions (§26.2/§33.2)", () => {
  it("rejects a subscription to Business B's conversation, even by a known real id (404, not a live stream)", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const convB = await dbB.conversation.create({ data: { channel: "whatsapp" } });

    const { GET } = await import("@/app/api/realtime/route");
    const response = await GET(
      authedRequest("/api/realtime", { searchParams: { channel: `conversation:${convB.id}` } })
    );

    expect(response.status).toBe(404);
  });

  it("accepts a subscription to Business A's own conversation", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const convA = await dbA.conversation.create({ data: { channel: "whatsapp" } });

    const { GET } = await import("@/app/api/realtime/route");
    const response = await GET(
      authedRequest("/api/realtime", { searchParams: { channel: `conversation:${convA.id}` } })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("rejects a client-supplied channel that tries to name a tenant prefix directly", async () => {
    const { GET } = await import("@/app/api/realtime/route");
    const response = await GET(
      authedRequest("/api/realtime", { searchParams: { channel: `tenant:${businessB.businessId}:global` } })
    );

    // Doesn't match "global" or "conversation:<id>" — rejected as invalid,
    // never interpreted as a request to join another tenant's channel.
    expect(response.status).toBe(400);
  });

  it("accepts the bare 'global' channel, always resolved to the caller's own tenant-prefixed one", async () => {
    const { GET } = await import("@/app/api/realtime/route");
    const response = await GET(authedRequest("/api/realtime", { searchParams: { channel: "global" } }));

    expect(response.status).toBe(200);
  });
});
