import { NextRequest } from "next/server";
import { webChatAdapter } from "@/lib/channels/webchat-adapter";
import { subscribe, tenantConversationChannel } from "@/lib/realtime/realtime";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ connectionId: string }> };

/**
 * PLAN.md §20.4/§26.2/§46.5 — the public counterpart to `/api/realtime`
 * (which requires an authenticated admin `TenantContext`): a widget
 * authenticates with its publishable token + Origin instead of a JWT/API
 * key, and may only subscribe to a conversation that (a) belongs to the
 * token's own business and (b) was created through *this exact*
 * `connectionId` — not merely "any webchat conversation for this
 * business" — so Business A's widget token can never observe Business B's
 * traffic, and one connection/widget cannot observe another connection's
 * conversation even within the same business (§46.5's own named isolation
 * test).
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const { connectionId } = await context.params;
  const token = request.nextUrl.searchParams.get("token") || "";
  const conversationId = request.nextUrl.searchParams.get("conversationId") || "";
  const origin = request.headers.get("origin") || "";

  const ctx = await webChatAdapter.authenticateWidget(connectionId, token, origin);
  if (!ctx || !conversationId) {
    return new Response("Forbidden", { status: 403 });
  }

  const db = getScopedPrisma(ctx);
  const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
  const owningConnectionId =
    conversation && typeof conversation.metadata === "object" && conversation.metadata !== null
      ? (conversation.metadata as Record<string, unknown>).channelConnectionId
      : undefined;

  if (!conversation || owningConnectionId !== connectionId) {
    return new Response("Not Found", { status: 404 });
  }

  const channel = tenantConversationChannel(ctx.businessId, conversationId);

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected" })}\n\n`));

      const unsubscribe = subscribe(channel, (event) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          unsubscribe();
        }
      });

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          clearInterval(heartbeat);
          unsubscribe();
        }
      }, 30000);

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
