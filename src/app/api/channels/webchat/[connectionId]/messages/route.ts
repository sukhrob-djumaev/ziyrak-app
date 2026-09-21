import { NextRequest, NextResponse } from "next/server";
import { webChatAdapter } from "@/lib/channels/webchat-adapter";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ connectionId: string }> };

/**
 * PLAN.md §17.3/§20.4/§46.7 — the *correctness path* for Web Chat replies.
 * `chat()` runs inside the standalone worker process (§25.3), whose in-memory
 * `RealtimeBus` is not the web process's: a reply published there never
 * reaches a widget subscribed to `/stream` in the web process (Phase 8's
 * Redis-backed bus is what makes that path cross-process). The reply is,
 * however, always persisted — so the widget reads persisted messages here,
 * exactly as §17.3 prescribes ("realtime is best-effort, never the
 * correctness path"). This also lets a visitor who reloads the page recover
 * their conversation (continuity), and delivers a scheduled follow-up that
 * arrives while no stream is open.
 *
 * Authorization is the same three layers as the stream route — token +
 * Origin + this exact connection — plus the visitor's own id: the token is
 * public by design, so a conversation may only be read by the visitor that
 * started it.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const { connectionId } = await context.params;
  const origin = request.headers.get("origin") || "";
  const cors = await webChatAdapter.corsHeadersFor(connectionId, origin).catch(() => ({}));
  const reply = (body: string, status: number) => new NextResponse(body, { status, headers: cors });

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  // Polled every few seconds by an open widget — ~20/min is normal.
  if (!checkRateLimit(`webchat-poll-ip:${connectionId}:${ip}`, { maxRequests: 90, windowMs: 60_000 }).allowed) {
    return reply("Too Many Requests", 429);
  }

  const params = request.nextUrl.searchParams;
  const token = params.get("token") || "";
  const conversationId = params.get("conversationId") || "";
  const visitorId = params.get("visitorId") || "";
  const after = params.get("after") || "";

  const ctx = await webChatAdapter.authenticateWidget(connectionId, token, origin);
  if (!ctx || !conversationId || !visitorId) return reply("Forbidden", 403);

  const db = getScopedPrisma(ctx);
  const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
  const owningConnectionId = (conversation?.metadata as Record<string, unknown> | null)?.channelConnectionId;
  if (!conversation || owningConnectionId !== connectionId || conversation.customerContact !== visitorId) {
    // Indistinguishable from "no such conversation" (§33.3).
    return reply("Not Found", 404);
  }

  let afterDate: Date | undefined;
  if (after) {
    const cursor = await db.message.findFirst({ where: { id: after, conversationId } });
    afterDate = cursor?.createdAt;
  }

  const messages = await db.message.findMany({
    where: {
      conversationId,
      role: { in: ["customer", "assistant"] },
      // `gte` + excluding the cursor itself: two messages can share a
      // millisecond timestamp, and `gt` would silently skip the later one.
      // Anything re-sent is de-duplicated by id in the widget.
      ...(afterDate && { createdAt: { gte: afterDate }, id: { not: after } }),
    },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { id: true, role: true, content: true, createdAt: true },
  });

  return NextResponse.json({ messages }, { headers: { ...cors, "Cache-Control": "no-store" } });
}
