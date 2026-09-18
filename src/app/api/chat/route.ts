import { NextRequest, NextResponse } from "next/server";
import { chat, createNewConversation } from "@/lib/ai/engine";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";

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

    let convId = conversationId;

    if (!convId) {
      // createNewConversation()/chat() below resolve entirely against
      // ctx.businessId (§16.2) and fail closed via
      // assertDefaultBusinessOnly() if this business isn't the one the AI
      // chat pipeline's still-global Settings-derived config represents
      // (Phase 2 runtime-isolation audit finding) — never silently against
      // the Default Business regardless of who's actually asking.
      const conversation = await createNewConversation(
        ctx,
        channel || "api",
        customerName || "API User",
        customerContact || ""
      );
      convId = conversation.id;
    }

    const response = await chat(ctx, convId, message.trim());

    return NextResponse.json({
      conversationId: convId,
      response,
    });
  } catch (error) {
    logger.error("Failed to process chat message:", error);
    return toErrorResponse(error);
  }
}
