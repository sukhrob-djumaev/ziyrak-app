import { NextRequest, NextResponse } from "next/server";
import { subscribe, tenantGlobalChannel, tenantConversationChannel } from "@/lib/realtime/realtime";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

import { refreshStreamAuthority } from "@/lib/identity/stream-authority";
import { authorizedEventStream } from "@/lib/realtime/authorized-stream";
import { projectDashboardEvent } from "@/lib/identity/stream-event-projection";

export const dynamic = "force-dynamic";

const CONVERSATION_CHANNEL = /^conversation:(.+)$/;

/**
 * PLAN.md §26.2/§33.2 — the client only ever names a *relative* channel
 * (`global` or `conversation:<id>`); the actual tenant-prefixed channel
 * (`tenant:<businessId>:...`) is always constructed here from the
 * authenticated `ctx.businessId`, never accepted from the client, closing
 * off any attempt to subscribe to another business's channel by supplying
 * a `tenant:` prefix directly. A `conversation:<id>` subscription is only
 * honored once the conversation is confirmed to belong to the caller's own
 * business (via the tenant-scoped Prisma client) — guessing/reusing a
 * known id from another business resolves to 404, never a live stream.
 */
export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "conversations:read");
  if (!isAuthenticated(ctx)) return ctx;

  const requested = request.nextUrl.searchParams.get("channel") || "global";

  let channel: string;
  let boundConversationId: string | undefined;
  if (requested === "global") {
    channel = tenantGlobalChannel(ctx.businessId);
  } else {
    const match = requested.match(CONVERSATION_CHANNEL);
    if (!match) {
      return NextResponse.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: 'channel must be "global" or "conversation:<id>"',
          },
        },
        { status: 400 }
      );
    }
    const conversationId = match[1];
    boundConversationId = conversationId;
    const db = getScopedPrisma(ctx);
    const conversation = await db.conversation.findUnique({
      where: { id: conversationId, retiredAt: null },
    });
    if (!conversation) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Conversation not found" } },
        { status: 404 }
      );
    }
    channel = tenantConversationChannel(ctx.businessId, conversationId);
  }

  const stream = authorizedEventStream({
    signal: request.signal,
    connected: { type: "connected", channel: requested },
    subscribe: (callback) => subscribe(channel, callback),
    refresh: async () => {
      const current = await refreshStreamAuthority(request, ctx);
      if (!current) return null;
      if (
        boundConversationId &&
        !(await getScopedPrisma(current).conversation.findFirst({
          where: { id: boundConversationId, retiredAt: null },
          select: { id: true },
        }))
      )
        return null;
      return current;
    },
    project: (current, event) => projectDashboardEvent(current, ctx, event),
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
