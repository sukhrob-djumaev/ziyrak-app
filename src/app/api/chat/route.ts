import { NextRequest, NextResponse } from "next/server";
import { processInboundMessage } from "@/lib/conversations/inbound";
import { buildMessageReceivedEvent } from "@/lib/events/types";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";

/**
 * PLAN.md §17.6/§18.2/§46.5 — the internal chat API's own worked example:
 * builds a normalized event and calls `processInboundMessage(ctx, event)`
 * directly, awaited in the same request/response cycle (no webhook
 * acknowledgment deadline to respect, so no dedup/enqueue step — those are
 * for real provider channels, §17.4/§17.6). This route no longer
 * duplicates "resolve customer → find/create conversation → chat()" itself
 * at all; `processInboundMessage` is now the only place that logic exists.
 */
export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "conversations:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { message, conversationId, channel, customerName, customerContact } = body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    if (message.length > 10000) {
      return NextResponse.json({ error: "Message exceeds maximum length of 10000 characters" }, { status: 400 });
    }

    const event = buildMessageReceivedEvent({
      businessId: ctx.businessId,
      channel: channel || "api",
      connectionId: "internal-chat-api",
      conversationId: conversationId || undefined,
      payload: {
        text: message.trim(),
        customerName: customerName || "API User",
        customerContact: customerContact || "",
      },
    });

    const result = await processInboundMessage(ctx, event);

    return NextResponse.json(result);
  } catch (error) {
    logger.error("Failed to process chat message:", error);
    return toErrorResponse(error);
  }
}
