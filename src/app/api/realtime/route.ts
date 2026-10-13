import { NextRequest, NextResponse } from "next/server";
import { subscribe, tenantGlobalChannel, tenantConversationChannel } from "@/lib/realtime/realtime";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { verifyActiveToken } from "@/lib/identity/auth";
import { logger } from "@/lib/observability/logger";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

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
  if (requested === "global") {
    channel = tenantGlobalChannel(ctx.businessId);
  } else {
    const match = requested.match(CONVERSATION_CHANNEL);
    if (!match) {
      return NextResponse.json(
        { error: { code: "VALIDATION_ERROR", message: "channel must be \"global\" or \"conversation:<id>\"" } },
        { status: 400 }
      );
    }
    const conversationId = match[1];
    const db = getScopedPrisma(ctx);
    const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Conversation not found" } },
        { status: 404 }
      );
    }
    channel = tenantConversationChannel(ctx.businessId, conversationId);
  }

  // The session this stream was opened under. requireAuth() ran once, at connect;
  // the heartbeat below re-checks the session so a signed-out (or expired) token
  // stops receiving the tenant's live events instead of streaming until the
  // client disconnects. API-key callers have no session token to re-check.
  const sessionToken = request.cookies.get("owly-token")?.value;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      // Send initial connection event
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "connected", channel: requested })}\n\n`)
      );

      // Subscribe to events
      const unsubscribe = subscribe(channel, (event) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        } catch {
          unsubscribe();
        }
      });

      const endStream = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed
        }
      };

      // Heartbeat every 30 seconds, which is also how soon a signed-out session is cut off.
      const heartbeat = setInterval(async () => {
        try {
          if (sessionToken && !(await verifyActiveToken(sessionToken))) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "session_ended" })}\n\n`));
            endStream();
            return;
          }
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch (error) {
          if (error instanceof TypeError) {
            // enqueue on a closed controller: the client is gone.
            endStream();
          } else {
            // A failed session lookup (transient database error) must not drop live streams; the next beat retries.
            logger.error("[realtime] session re-check failed", error);
          }
        }
      }, 30000);

      // Cleanup on abort
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
