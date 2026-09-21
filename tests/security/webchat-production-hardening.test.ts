import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import crypto from "crypto";

// Real Postgres + real auth + the real admin/public route handlers — proves
// the production Web Chat hardening (§20.4/§46.7) end to end, including the
// hostile cases: forged/rotated/revoked tokens, cross-business and
// cross-connection use, unconfigured origins, guessed conversation ids.
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { generateToken } from "@/lib/identity/auth";
import { createAuthenticatedRequest, createRequest, parseJsonResponse } from "../helpers/request";
import { seedBusiness, addMember, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { webChatAdapter } from "@/lib/channels/webchat-adapter";
import { emitNewMessage } from "@/lib/realtime/realtime";
import type { NormalizedInboundRequest } from "@/lib/channels/types";
import { NextRequest } from "next/server";

const ORIGIN = "https://shop-a.example.com";
const OTHER_ORIGIN = "https://evil.example.com";

let businessA: SeededBusiness;
let businessB: SeededBusiness;
let tokenA: string;
let tokenB: string;
let agentTokenA: string;

async function adminCall(
  handler: (req: NextRequest, ctx: { params: Promise<{ connectionId: string }> }) => Promise<Response>,
  path: string,
  authToken: string,
  method: string,
  body?: Record<string, unknown>,
  connectionId = "unused"
) {
  const request = createAuthenticatedRequest(path, authToken, { method, body });
  return handler(request, { params: Promise.resolve({ connectionId }) });
}

async function createConnection(authToken: string, allowedOrigins: string[] = [ORIGIN]) {
  const { POST } = await import("@/app/api/channels/webchat-connections/route");
  const response = await POST(createAuthenticatedRequest("/api/channels/webchat-connections", authToken, { method: "POST", body: { allowedOrigins } }));
  return { response, data: await parseJsonResponse(response) };
}

function message(
  connectionId: string,
  token: string,
  origin: string,
  conversationId: string,
  extra: { customerContact?: string; text?: string } = {}
): NormalizedInboundRequest {
  return {
    headers: { origin },
    routeParams: { connectionId },
    json: {
      token,
      conversationId,
      clientMessageId: crypto.randomUUID(),
      customerContact: extra.customerContact ?? crypto.randomUUID(),
      text: extra.text ?? "Hello",
    },
    url: `https://example.com/api/channels/webchat/${connectionId}/message`,
  };
}

beforeAll(async () => {
  businessA = await seedBusiness("wc-prod-a");
  businessB = await seedBusiness("wc-prod-b");
  tokenA = generateToken(businessA.ownerUserId);
  tokenB = generateToken(businessB.ownerUserId);
  const agent = await addMember(businessA.businessId, "agent", "wc-agent");
  agentTokenA = generateToken(agent.userId);
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

describe("Web Chat connection management (§20.4/§46.7)", () => {
  it("creates a connection, returns the token and a versioned embed snippet exactly once, and never stores the token in plaintext", async () => {
    const { response, data } = await createConnection(tokenA);
    expect(response.status).toBe(201);
    expect(data.token).toMatch(/^zy_pub_[0-9a-f]{48}$/);
    expect(data.embedSnippet).toContain(`data-connection-id="${data.connectionId}"`);
    expect(data.embedSnippet).toContain(`data-token="${data.token}"`);
    expect(data.embedSnippet).toMatch(/widget\.js\?v=\d+/);

    const row = await prisma.channelConnection.findUnique({ where: { id: data.connectionId } });
    expect(row?.credentialRef).toBeTruthy();
    expect(row!.credentialRef).not.toContain(data.token);
    expect(row!.businessId).toBe(businessA.businessId);

    const { GET } = await import("@/app/api/channels/webchat-connections/route");
    const list = await parseJsonResponse(await GET(createAuthenticatedRequest("/api/channels/webchat-connections", tokenA)));
    expect(JSON.stringify(list)).not.toContain(data.token);
  });

  it.each([
    ["an empty origin list", []],
    ["an origin with a path", ["https://example.com/app"]],
    ["an origin with a trailing slash", ["https://example.com/"]],
    ["a non-http(s) origin", ["ftp://example.com"]],
    ["a wildcard", ["*"]],
  ])("rejects %s with a clear 400 instead of creating an unusable connection", async (_label, allowedOrigins) => {
    const { response } = await createConnection(tokenA, allowedOrigins as string[]);
    expect(response.status).toBe(400);
  });

  it("requires channels:update — an agent cannot create, rotate, or edit a widget", async () => {
    const { response } = await createConnection(agentTokenA);
    expect(response.status).toBe(403);
  });

  it("Business B cannot rotate or edit Business A's connection (404, not 403)", async () => {
    const { data } = await createConnection(tokenA);
    const rotate = await import("@/app/api/channels/webchat-connections/[connectionId]/rotate-token/route");
    const patch = await import("@/app/api/channels/webchat-connections/[connectionId]/route");

    const rotated = await adminCall(rotate.POST, `/x/${data.connectionId}/rotate-token`, tokenB, "POST", undefined, data.connectionId);
    expect(rotated.status).toBe(404);

    const edited = await adminCall(patch.PATCH, `/x/${data.connectionId}`, tokenB, "PATCH", { allowedOrigins: [OTHER_ORIGIN] }, data.connectionId);
    expect(edited.status).toBe(404);

    // ...and A's connection is untouched.
    const row = await prisma.channelConnection.findUnique({ where: { id: data.connectionId } });
    expect((row!.config as { allowedOrigins: string[] }).allowedOrigins).toEqual([ORIGIN]);
  });
});

describe("token rotation and revocation (§20.4/§46.7 acceptance criterion)", () => {
  it("rotating a token invalidates the old one immediately and touches no other credential", async () => {
    const first = (await createConnection(tokenA)).data;
    const bystander = (await createConnection(tokenA)).data;
    const apiKey = await prisma.apiKey.create({
      data: { businessId: businessA.businessId, name: "bystander", keyPrefix: "zy_live_bystand", keyHash: crypto.randomBytes(16).toString("hex") },
    });
    const bystanderBefore = await prisma.channelConnection.findUnique({ where: { id: bystander.connectionId } });

    const conversationId = crypto.randomUUID();
    expect((await webChatAdapter.validateInbound(message(first.connectionId, first.token, ORIGIN, conversationId))).kind).toBe("new");

    const rotate = await import("@/app/api/channels/webchat-connections/[connectionId]/rotate-token/route");
    const response = await adminCall(rotate.POST, "/x", tokenA, "POST", undefined, first.connectionId);
    expect(response.status).toBe(200);
    const rotated = await parseJsonResponse(response);
    expect(rotated.token).not.toBe(first.token);

    expect((await webChatAdapter.validateInbound(message(first.connectionId, first.token, ORIGIN, crypto.randomUUID()))).kind).toBe("rejected");
    expect((await webChatAdapter.validateInbound(message(first.connectionId, rotated.token, ORIGIN, crypto.randomUUID()))).kind).toBe("new");

    // Nothing else moved: another widget's credential and an admin API key are byte-identical.
    const bystanderAfter = await prisma.channelConnection.findUnique({ where: { id: bystander.connectionId } });
    expect(bystanderAfter!.credentialRef).toBe(bystanderBefore!.credentialRef);
    expect((await webChatAdapter.validateInbound(message(bystander.connectionId, bystander.token, ORIGIN, crypto.randomUUID()))).kind).toBe("new");
    const apiKeyAfter = await prisma.apiKey.findUnique({ where: { id: apiKey.id } });
    expect(apiKeyAfter!.keyHash).toBe(apiKey.keyHash);
    expect(apiKeyAfter!.revokedAt).toBeNull();
  });

  it("deactivating a connection (revocation) makes its token stop working", async () => {
    const conn = (await createConnection(tokenA)).data;
    const patch = await import("@/app/api/channels/webchat-connections/[connectionId]/route");
    const response = await adminCall(patch.PATCH, "/x", tokenA, "PATCH", { isActive: false }, conn.connectionId);
    expect(response.status).toBe(200);

    expect((await webChatAdapter.validateInbound(message(conn.connectionId, conn.token, ORIGIN, crypto.randomUUID()))).kind).toBe("rejected");
  });

  it("updating allowed origins takes effect immediately, without rotating the token", async () => {
    const conn = (await createConnection(tokenA)).data;
    const patch = await import("@/app/api/channels/webchat-connections/[connectionId]/route");

    expect((await webChatAdapter.validateInbound(message(conn.connectionId, conn.token, OTHER_ORIGIN, crypto.randomUUID()))).kind).toBe("rejected");
    await adminCall(patch.PATCH, "/x", tokenA, "PATCH", { allowedOrigins: [ORIGIN, OTHER_ORIGIN] }, conn.connectionId);
    expect((await webChatAdapter.validateInbound(message(conn.connectionId, conn.token, OTHER_ORIGIN, crypto.randomUUID()))).kind).toBe("new");
  });
});

describe("hostile widget requests (§20.4/§34.3 item 7)", () => {
  it("rejects a forged token, an unconfigured origin, and a missing origin", async () => {
    const conn = (await createConnection(tokenA)).data;
    expect((await webChatAdapter.validateInbound(message(conn.connectionId, "zy_pub_" + "0".repeat(48), ORIGIN, crypto.randomUUID()))).kind).toBe("rejected");
    expect((await webChatAdapter.validateInbound(message(conn.connectionId, conn.token, OTHER_ORIGIN, crypto.randomUUID()))).kind).toBe("rejected");
    expect((await webChatAdapter.validateInbound(message(conn.connectionId, conn.token, "", crypto.randomUUID()))).kind).toBe("rejected");
  });

  it("a token for connection 1 cannot be used against connection 2 (same business), nor against another business's connection", async () => {
    const c1 = (await createConnection(tokenA)).data;
    const c2 = (await createConnection(tokenA)).data;
    const b1 = (await createConnection(tokenB)).data;

    expect((await webChatAdapter.validateInbound(message(c2.connectionId, c1.token, ORIGIN, crypto.randomUUID()))).kind).toBe("rejected");
    expect((await webChatAdapter.validateInbound(message(b1.connectionId, c1.token, ORIGIN, crypto.randomUUID()))).kind).toBe("rejected");
    expect((await webChatAdapter.validateInbound(message(c1.connectionId, b1.token, ORIGIN, crypto.randomUUID()))).kind).toBe("rejected");
  });

  it("a known conversation id cannot be used by another visitor, or through another connection, to write into that thread", async () => {
    const c1 = (await createConnection(tokenA)).data;
    const c2 = (await createConnection(tokenA)).data;
    const { processInboundMessage } = await import("@/lib/conversations/inbound");

    const conversationId = crypto.randomUUID();
    const visitor = crypto.randomUUID();
    const first = await webChatAdapter.validateInbound(message(c1.connectionId, c1.token, ORIGIN, conversationId, { customerContact: visitor }));
    expect(first.kind).toBe("new");
    if (first.kind !== "new") return;
    await processInboundMessage(first.ctx, first.event);
    const messagesBefore = await prisma.message.count({ where: { conversationId } });

    // Same widget, legitimate visitor: fine.
    expect((await webChatAdapter.validateInbound(message(c1.connectionId, c1.token, ORIGIN, conversationId, { customerContact: visitor }))).kind).toBe("new");
    // A different visitor who learned the conversation id: refused.
    expect((await webChatAdapter.validateInbound(message(c1.connectionId, c1.token, ORIGIN, conversationId, { customerContact: crypto.randomUUID() }))).kind).toBe("rejected");
    // A different widget (connection 2, valid token/origin) in the same business: refused.
    expect((await webChatAdapter.validateInbound(message(c2.connectionId, c2.token, ORIGIN, conversationId, { customerContact: visitor }))).kind).toBe("rejected");

    expect(await prisma.message.count({ where: { conversationId } })).toBe(messagesBefore);
  });

  it("a visitor of Business B presenting Business A's conversation id cannot read or write A's conversation", async () => {
    const a = (await createConnection(tokenA)).data;
    const b = (await createConnection(tokenB)).data;
    const { processInboundMessage } = await import("@/lib/conversations/inbound");

    const conversationId = crypto.randomUUID();
    const visitor = crypto.randomUUID();
    const first = await webChatAdapter.validateInbound(message(a.connectionId, a.token, ORIGIN, conversationId, { customerContact: visitor }));
    if (first.kind !== "new") throw new Error("setup failed");
    await processInboundMessage(first.ctx, first.event);
    const before = await prisma.message.count({ where: { conversationId } });

    const cross = await webChatAdapter.validateInbound(message(b.connectionId, b.token, ORIGIN, conversationId, { customerContact: visitor }));
    if (cross.kind === "new") {
      // If it gets past validation, processing must still be unable to touch A's rows.
      await expect(processInboundMessage(cross.ctx, cross.event)).rejects.toThrow();
    }
    expect(await prisma.message.count({ where: { conversationId } })).toBe(before);
    expect((await prisma.conversation.findUnique({ where: { id: conversationId } }))!.businessId).toBe(businessA.businessId);

    // And B's token cannot subscribe to A's conversation stream (real route).
    const { GET } = await import("@/app/api/channels/webchat/[connectionId]/stream/route");
    const response = await GET(
      createRequest(`/api/channels/webchat/${b.connectionId}/stream`, { headers: { origin: ORIGIN }, searchParams: { token: b.token, conversationId } }),
      { params: Promise.resolve({ connectionId: b.connectionId }) }
    );
    expect(response.status).toBe(404);
  });

  it("rejects malformed/oversized input before persisting anything", async () => {
    const conn = (await createConnection(tokenA)).data;
    expect((await webChatAdapter.validateInbound(message(conn.connectionId, conn.token, ORIGIN, "not-a-uuid"))).kind).toBe("rejected");
    expect((await webChatAdapter.validateInbound(message(conn.connectionId, conn.token, ORIGIN, crypto.randomUUID(), { text: "x".repeat(4001) }))).kind).toBe("rejected");
  });

  it("escalation metadata no longer detaches a Web Chat conversation from its connection", async () => {
    const conn = (await createConnection(tokenA)).data;
    const { processInboundMessage } = await import("@/lib/conversations/inbound");
    const conversationId = crypto.randomUUID();
    const visitor = crypto.randomUUID();

    const first = await webChatAdapter.validateInbound(message(conn.connectionId, conn.token, ORIGIN, conversationId, { customerContact: visitor }));
    if (first.kind !== "new") throw new Error("setup failed");
    await processInboundMessage(first.ctx, first.event);

    const { recordEscalationSignal } = await import("@/lib/conversations/messaging");
    await recordEscalationSignal(first.ctx, conversationId, { escalationReason: "refund", sentiment: "negative", intent: "refund" });

    const row = await prisma.conversation.findUnique({ where: { id: conversationId } });
    const metadata = row!.metadata as Record<string, unknown>;
    expect(metadata.channelConnectionId).toBe(conn.connectionId);
    expect(metadata.escalationReason).toBe("refund");

    // The widget can still send follow-ups after an escalation signal.
    expect((await webChatAdapter.validateInbound(message(conn.connectionId, conn.token, ORIGIN, conversationId, { customerContact: visitor }))).kind).toBe("new");
  });
});

describe("cross-origin behavior of the public routes (§20.4/§46.7)", () => {
  it("answers the CORS preflight only for an allowed origin, and never with a wildcard", async () => {
    const conn = (await createConnection(tokenA)).data;
    const { OPTIONS } = await import("@/app/api/channels/webchat/[connectionId]/message/route");
    const ctx = { params: Promise.resolve({ connectionId: conn.connectionId }) };

    const allowed = await OPTIONS(new NextRequest(`http://localhost/api/channels/webchat/${conn.connectionId}/message`, { method: "OPTIONS", headers: { origin: ORIGIN } }), ctx);
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(allowed.headers.get("access-control-allow-origin")).not.toBe("*");

    const denied = await OPTIONS(new NextRequest(`http://localhost/api/channels/webchat/${conn.connectionId}/message`, { method: "OPTIONS", headers: { origin: OTHER_ORIGIN } }), ctx);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("a rejected POST from an allowed origin still carries CORS headers so the widget can read the error", async () => {
    const conn = (await createConnection(tokenA)).data;
    const { POST } = await import("@/app/api/channels/webchat/[connectionId]/message/route");
    const request = createRequest(`/api/channels/webchat/${conn.connectionId}/message`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-forwarded-for": "203.0.113.77" },
      body: { token: "zy_pub_wrong", conversationId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), text: "hi" },
    });
    const response = await POST(request, { params: Promise.resolve({ connectionId: conn.connectionId }) });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
});

describe("human handoff reaches the widget's channel (§44.3/§46.7)", () => {
  it("an agent's dashboard reply is emitted as an 'assistant' message on the same conversation the widget streams", async () => {
    const conn = (await createConnection(tokenA)).data;
    const { processInboundMessage } = await import("@/lib/conversations/inbound");
    const conversationId = crypto.randomUUID();
    const first = await webChatAdapter.validateInbound(message(conn.connectionId, conn.token, ORIGIN, conversationId));
    if (first.kind !== "new") throw new Error("setup failed");
    await processInboundMessage(first.ctx, first.event);

    const { POST } = await import("@/app/api/conversations/[id]/messages/route");
    vi.mocked(emitNewMessage).mockClear();
    const response = await POST(
      createAuthenticatedRequest(`/api/conversations/${conversationId}/messages`, agentTokenA, { method: "POST", body: { content: "Hi, a human here." } }),
      { params: Promise.resolve({ id: conversationId }) }
    );
    expect(response.status).toBe(201);
    // The widget only renders role === "assistant" frames (public/widget.js) —
    // a human reply must use that exact role, on this business + conversation.
    expect(emitNewMessage).toHaveBeenCalledWith(businessA.businessId, conversationId, expect.objectContaining({ role: "assistant", content: "Hi, a human here." }));
  });

  it("an agent of Business B cannot post into Business A's conversation", async () => {
    const conn = (await createConnection(tokenA)).data;
    const { processInboundMessage } = await import("@/lib/conversations/inbound");
    const conversationId = crypto.randomUUID();
    const first = await webChatAdapter.validateInbound(message(conn.connectionId, conn.token, ORIGIN, conversationId));
    if (first.kind !== "new") throw new Error("setup failed");
    await processInboundMessage(first.ctx, first.event);

    const { POST } = await import("@/app/api/conversations/[id]/messages/route");
    const response = await POST(
      createAuthenticatedRequest(`/api/conversations/${conversationId}/messages`, tokenB, { method: "POST", body: { content: "intruder" } }),
      { params: Promise.resolve({ id: conversationId }) }
    );
    expect(response.status).toBe(404);
  });
});
