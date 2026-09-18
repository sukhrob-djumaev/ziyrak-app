import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §33.1 — tenant isolation matrix for the "conversations" module.
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
  businessA = await seedBusiness("conversations-isolation-a");
  businessB = await seedBusiness("conversations-isolation-b");
  tokenA = generateToken(businessA.ownerUserId);
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

function authedRequest(path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": tokenA, ...options.cookies } });
}

describe("tenant isolation: conversations (§33.1)", () => {
  it("Business A cannot list Business B's conversations", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const convB = await dbB.conversation.create({ data: { channel: "whatsapp", customerName: "B-only" } });

    const { GET } = await import("@/app/api/conversations/route");
    const response = await GET(authedRequest("/api/conversations", { searchParams: { limit: "200" } }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data.map((c: { id: string }) => c.id)).not.toContain(convB.id);
  });

  it("Business A cannot fetch Business B's conversation by known id (404)", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const convB = await dbB.conversation.create({ data: { channel: "whatsapp" } });

    const { GET } = await import("@/app/api/conversations/[id]/route");
    const response = await GET(authedRequest(`/api/conversations/${convB.id}`), {
      params: Promise.resolve({ id: convB.id }),
    });

    expect(response.status).toBe(404);
  });

  it("Business A cannot update Business B's conversation by known id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const convB = await dbB.conversation.create({ data: { channel: "whatsapp", status: "active" } });

    const { PUT } = await import("@/app/api/conversations/[id]/route");
    const response = await PUT(
      authedRequest(`/api/conversations/${convB.id}`, { method: "PUT", body: { status: "closed" } }),
      { params: Promise.resolve({ id: convB.id }) }
    );

    expect(response.status).toBe(404);
    const stillActive = await dbB.conversation.findUnique({ where: { id: convB.id } });
    expect(stillActive?.status).toBe("active");
  });

  it("Business A cannot delete Business B's conversation by known id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const convB = await dbB.conversation.create({ data: { channel: "whatsapp" } });

    const { DELETE } = await import("@/app/api/conversations/[id]/route");
    const response = await DELETE(authedRequest(`/api/conversations/${convB.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: convB.id }),
    });

    expect(response.status).toBe(404);
    expect(await dbB.conversation.findUnique({ where: { id: convB.id } })).not.toBeNull();
  });

  it("Business A cannot read Business B's conversation messages via a known id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const convB = await dbB.conversation.create({ data: { channel: "whatsapp" } });
    await dbB.message.create({ data: { conversationId: convB.id, role: "customer", content: "secret" } });

    const { GET } = await import("@/app/api/conversations/[id]/messages/route");
    const response = await GET(authedRequest(`/api/conversations/${convB.id}/messages`), {
      params: Promise.resolve({ id: convB.id }),
    });

    expect(response.status).toBe(404);
  });

  it("Business A cannot post a message into Business B's conversation via a known id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const convB = await dbB.conversation.create({ data: { channel: "whatsapp" } });

    const { POST } = await import("@/app/api/conversations/[id]/messages/route");
    const response = await POST(
      authedRequest(`/api/conversations/${convB.id}/messages`, { method: "POST", body: { content: "injected" } }),
      { params: Promise.resolve({ id: convB.id }) }
    );

    expect(response.status).toBe(404);
    const messages = await dbB.message.findMany({ where: { conversationId: convB.id } });
    expect(messages).toHaveLength(0);
  });

  it("Business A cannot read or add internal notes on Business B's conversation", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const convB = await dbB.conversation.create({ data: { channel: "whatsapp" } });

    const { GET } = await import("@/app/api/conversations/[id]/notes/route");
    const getResponse = await GET(authedRequest(`/api/conversations/${convB.id}/notes`), {
      params: Promise.resolve({ id: convB.id }),
    });
    expect(getResponse.status).toBe(404);

    const { POST } = await import("@/app/api/conversations/[id]/notes/route");
    const postResponse = await POST(
      authedRequest(`/api/conversations/${convB.id}/notes`, { method: "POST", body: { content: "injected" } }),
      { params: Promise.resolve({ id: convB.id }) }
    );
    expect(postResponse.status).toBe(404);
  });

  it("Business A cannot set satisfaction on Business B's conversation by known id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const convB = await dbB.conversation.create({ data: { channel: "whatsapp" } });

    const { POST } = await import("@/app/api/conversations/[id]/satisfaction/route");
    const response = await POST(
      authedRequest(`/api/conversations/${convB.id}/satisfaction`, { method: "POST", body: { rating: 5 } }),
      { params: Promise.resolve({ id: convB.id }) }
    );

    expect(response.status).toBe(404);
    const stillNull = await dbB.conversation.findUnique({ where: { id: convB.id } });
    expect(stillNull?.satisfaction).toBeNull();
  });

  it("Business A cannot merge Business B's conversation into its own via a known id", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);
    const primaryA = await dbA.conversation.create({ data: { channel: "whatsapp" } });
    const secondaryB = await dbB.conversation.create({ data: { channel: "email" } });

    const { POST } = await import("@/app/api/conversations/[id]/merge/route");
    const response = await POST(
      authedRequest(`/api/conversations/${primaryA.id}/merge`, {
        method: "POST",
        body: { secondaryId: secondaryB.id },
      }),
      { params: Promise.resolve({ id: primaryA.id }) }
    );

    // mergeConversations looks up both by id through the scoped client —
    // Business B's conversation resolves to not-found, so the merge fails.
    expect(response.status).toBe(400);
    const untouched = await dbB.conversation.findUnique({ where: { id: secondaryB.id } });
    expect(untouched?.status).not.toBe("closed");
  });

  it("Business A's own conversation is fully reachable (positive control)", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const convA = await dbA.conversation.create({ data: { channel: "whatsapp", customerName: "A-own" } });

    const { GET } = await import("@/app/api/conversations/[id]/route");
    const response = await GET(authedRequest(`/api/conversations/${convA.id}`), {
      params: Promise.resolve({ id: convA.id }),
    });
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.id).toBe(convA.id);
  });
});
