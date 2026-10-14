import { NextRequest } from "next/server";
import { webChatAdapter } from "@/lib/channels/webchat-adapter";
import { subscribe, tenantConversationChannel } from "@/lib/realtime/realtime";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { getClientIp } from "@/lib/client-ip";
import { checkRateLimit } from "@/lib/rate-limit";

import { authorizedEventStream } from "@/lib/realtime/authorized-stream";
import { projectWidgetEvent } from "@/lib/identity/stream-event-projection";

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

  // Each SSE connect does a DB-backed token/origin check — bound how often a
  // single IP can trigger one (long-lived streams themselves are cheap; the
  // repeated auth attempts are what an attacker would hammer).
  const ip = getClientIp(request);
  if (
    !(
      await checkRateLimit(`webchat-stream-ip:${connectionId}:${ip}`, {
        maxRequests: 30,
        windowMs: 60_000,
      })
    ).allowed
  ) {
    return new Response("Too Many Requests", { status: 429 });
  }

  const token = request.nextUrl.searchParams.get("token") || "";
  const conversationId = request.nextUrl.searchParams.get("conversationId") || "";
  const visitorId = request.nextUrl.searchParams.get("visitorId") || "";
  const origin = request.headers.get("origin") || "";
  // EventSource is a cross-origin "simple" request (no preflight), but the
  // browser still needs `Access-Control-Allow-Origin` on the response to let
  // the embedding page read the stream — granted only for an origin on this
  // connection's own allowlist (PLAN.md §20.4/§46.7).
  const cors = await webChatAdapter.corsHeadersFor(connectionId, origin).catch(() => ({}));

  const ctx = await webChatAdapter.authenticateWidget(connectionId, token, origin);
  if (!ctx || !conversationId || !visitorId) {
    return new Response("Forbidden", { status: 403 });
  }

  const db = getScopedPrisma(ctx);
  const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
  const owningConnectionId =
    conversation && typeof conversation.metadata === "object" && conversation.metadata !== null
      ? (conversation.metadata as Record<string, unknown>).channelConnectionId
      : undefined;

  if (
    !conversation ||
    owningConnectionId !== connectionId ||
    conversation.customerContact !== visitorId ||
    conversation.retiredAt
  ) {
    // With the CORS headers: a new visitor's widget opens this stream before
    // its conversation exists, and a header-less 404 is reported by the
    // browser as a CORS failure that also closes the EventSource for good.
    return new Response("Not Found", { status: 404, headers: cors });
  }

  const channel = tenantConversationChannel(ctx.businessId, conversationId);

  const stream = authorizedEventStream({
    signal: request.signal,
    connected: { type: "connected" },
    subscribe: (callback) => subscribe(channel, callback),
    refresh: async () => {
      const current = await webChatAdapter.authenticateWidget(connectionId, token, origin);
      if (!current || current.businessId !== ctx.businessId) return null;
      const owned = await getScopedPrisma(current).conversation.findFirst({
        where: {
          id: conversationId,
          retiredAt: null,
          channel: "webchat",
          customerContact: visitorId,
          metadata: { path: ["channelConnectionId"], equals: connectionId },
        },
        select: { id: true },
      });
      return owned ? current : null;
    },
    project: (current, event) => projectWidgetEvent(current, conversationId, event),
  });

  return new Response(stream, {
    headers: {
      ...cors,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
