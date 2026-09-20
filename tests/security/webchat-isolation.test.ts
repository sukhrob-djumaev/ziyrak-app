import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import crypto from "crypto";

// Real Postgres + real auth — this suite proves both the widget-token
// scoping (§20.4) and its structural inability to reach any admin route.
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { requireAuth } from "@/lib/identity/route-auth";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { encryptChannelCredential } from "@/lib/identity/channel-credential-auth";
import { webChatAdapter, generateWebChatToken } from "@/lib/channels/webchat-adapter";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { NormalizedInboundRequest } from "@/lib/channels/types";

/**
 * PLAN.md §20.4/§46.5's own named test list:
 *  - valid configured origin succeeds,
 *  - invalid origin fails,
 *  - the token cannot access any admin API,
 *  - Business A's widget cannot access Business B,
 *  - one connection/widget cannot access another connection's conversation.
 */

let businessA: SeededBusiness;
let businessB: SeededBusiness;
const ALLOWED_ORIGIN = "https://widget-a.example.com";

interface WebChatSetup {
  connectionId: string;
  token: string;
}

async function createWebChatConnection(businessId: string, allowedOrigins: string[]): Promise<WebChatSetup> {
  const token = generateWebChatToken();
  const credentialRef = await encryptChannelCredential({ type: "webchat", widgetSecret: token });
  const connection = await prisma.channelConnection.create({
    data: {
      businessId,
      type: "webchat",
      name: "Web Chat",
      isActive: true,
      config: { allowedOrigins },
      credentialRef,
    },
  });
  return { connectionId: connection.id, token };
}

function buildMessageRequest(connectionId: string, token: string, origin: string, conversationId: string): NormalizedInboundRequest {
  return {
    headers: { origin },
    routeParams: { connectionId },
    json: { token, conversationId, clientMessageId: crypto.randomUUID(), text: "Hello, I need help" },
    url: `https://example.com/api/channels/webchat/${connectionId}/message`,
  };
}

beforeAll(async () => {
  businessA = await seedBusiness("webchat-a");
  businessB = await seedBusiness("webchat-b");
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

describe("WebChat token/origin/tenant isolation (§20.4/§46.5)", () => {
  it("a request from the allowed origin, with the right token, succeeds", async () => {
    const { connectionId, token } = await createWebChatConnection(businessA.businessId, [ALLOWED_ORIGIN]);
    const conversationId = crypto.randomUUID();

    const result = await webChatAdapter.validateInbound(buildMessageRequest(connectionId, token, ALLOWED_ORIGIN, conversationId));

    expect(result.kind).toBe("new");
    if (result.kind === "new") {
      expect(result.ctx.businessId).toBe(businessA.businessId);
      expect(result.event.conversationId).toBe(conversationId);
    }
  });

  it("a request from a disallowed origin is rejected", async () => {
    const { connectionId, token } = await createWebChatConnection(businessA.businessId, [ALLOWED_ORIGIN]);

    const result = await webChatAdapter.validateInbound(
      buildMessageRequest(connectionId, token, "https://attacker.example.com", crypto.randomUUID())
    );

    expect(result.kind).toBe("rejected");
  });

  it("a request with the wrong token (right origin, right connection) is rejected", async () => {
    const { connectionId } = await createWebChatConnection(businessA.businessId, [ALLOWED_ORIGIN]);

    const result = await webChatAdapter.validateInbound(
      buildMessageRequest(connectionId, "zy_pub_totally-wrong-token", ALLOWED_ORIGIN, crypto.randomUUID())
    );

    expect(result.kind).toBe("rejected");
  });

  it("redelivery of the same clientMessageId is deduped", async () => {
    const { connectionId, token } = await createWebChatConnection(businessA.businessId, [ALLOWED_ORIGIN]);
    const request = buildMessageRequest(connectionId, token, ALLOWED_ORIGIN, crypto.randomUUID());

    expect((await webChatAdapter.validateInbound(request)).kind).toBe("new");
    expect((await webChatAdapter.validateInbound(request)).kind).toBe("duplicate");
  });

  it("the widget token is structurally incapable of authenticating any admin API (not an ApiKey, not a JWT)", async () => {
    const { token } = await createWebChatConnection(businessA.businessId, [ALLOWED_ORIGIN]);

    const request = createRequest("/api/customers", {
      method: "GET",
      headers: { "X-API-Key": token },
    });

    const result = await requireAuth(request, "customers:read");
    expect(result).not.toHaveProperty("businessId"); // i.e. it's an error NextResponse, not a TenantContext
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = result as any;
    expect(response.status).toBe(401);
    const data = await parseJsonResponse(response);
    expect(data.error.code).toBe("INVALID_API_KEY");
  });

  it("Business A's widget token cannot be used to authenticate as Business B's connection", async () => {
    const { token: tokenA } = await createWebChatConnection(businessA.businessId, [ALLOWED_ORIGIN]);
    const { connectionId: connectionIdB } = await createWebChatConnection(businessB.businessId, [ALLOWED_ORIGIN]);

    // Business A's token presented against Business B's connectionId path —
    // must fail, since the token is compared only against *that specific*
    // connection's own stored credential, never any cross-connection match.
    const ctx = await webChatAdapter.authenticateWidget(connectionIdB, tokenA, ALLOWED_ORIGIN);
    expect(ctx).toBeNull();
  });

  it("one connection cannot subscribe to another connection's conversation, even within the same business (real stream route)", async () => {
    const { connectionId: connectionId1, token: token1 } = await createWebChatConnection(businessA.businessId, [ALLOWED_ORIGIN]);
    const { connectionId: connectionId2, token: token2 } = await createWebChatConnection(businessA.businessId, [ALLOWED_ORIGIN]);

    const conversationId1 = crypto.randomUUID();
    const messageResult = await webChatAdapter.validateInbound(
      buildMessageRequest(connectionId1, token1, ALLOWED_ORIGIN, conversationId1)
    );
    expect(messageResult.kind).toBe("new");
    if (messageResult.kind !== "new") return;

    // Simulate what processInboundMessage's conversation-creation step does
    // (conversations/inbound.ts's webchat branch): stamp the owning
    // connectionId into the conversation's metadata.
    const db = getScopedPrisma(messageResult.ctx);
    await db.conversation.create({
      data: {
        id: conversationId1,
        businessId: businessA.businessId,
        channel: "webchat",
        customerName: "Visitor",
        customerContact: `webchat:${conversationId1}`,
        metadata: { channelConnectionId: connectionId1 },
      },
    });

    const { GET } = await import("@/app/api/channels/webchat/[connectionId]/stream/route");

    // connection2's own valid token/origin, but conversation1 belongs to
    // connection1 — the real route must refuse it (404, indistinguishable
    // from "doesn't exist", §33.3).
    const crossConnectionRequest = createRequest(`/api/channels/webchat/${connectionId2}/stream`, {
      headers: { origin: ALLOWED_ORIGIN },
      searchParams: { token: token2, conversationId: conversationId1 },
    });
    const crossConnectionResponse = await GET(crossConnectionRequest, { params: Promise.resolve({ connectionId: connectionId2 }) });
    expect(crossConnectionResponse.status).toBe(404);

    // The legitimate owner (connection1's own token) succeeds.
    const ownRequest = createRequest(`/api/channels/webchat/${connectionId1}/stream`, {
      headers: { origin: ALLOWED_ORIGIN },
      searchParams: { token: token1, conversationId: conversationId1 },
    });
    const ownResponse = await GET(ownRequest, { params: Promise.resolve({ connectionId: connectionId1 }) });
    expect(ownResponse.status).toBe(200);
    ownResponse.body?.cancel();
  });
});
