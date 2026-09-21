import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated, resolveActorDisplayName } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import { emitNewMessage } from "@/lib/realtime/realtime";
import * as conversationsService from "@/lib/conversations/service";
import { logActivity } from "@/lib/observability/activity";
import { deliverAgentReply } from "@/lib/conversations/agent-reply";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "messages:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const messages = await conversationsService.listMessages(ctx, id);
    return NextResponse.json(messages);
  } catch (error) {
    logger.error("Failed to fetch messages:", error);
    return toErrorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "messages:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const body = await request.json();
    const { content, role } = body;

    if (!content || typeof content !== "string" || content.trim().length === 0) {
      return NextResponse.json(
        { error: "Message content is required" },
        { status: 400 }
      );
    }

    const message = await conversationsService.addMessage(ctx, id, content, role);

    emitNewMessage(ctx.businessId, id, { id: message.id, role: message.role, content: message.content });
    await logActivity(ctx, "message.sent", "conversation", id, "A team member replied in the conversation", await resolveActorDisplayName(ctx));

    // Only a reply written *as the business* (assistant role) is sent out; a
    // "customer"/"system" row is a record, not something to transmit.
    const delivery = message.role === "assistant" ? await deliverAgentReply(ctx, id, message.content) : { status: "not_applicable" as const, reason: "Not an outbound reply" };

    return NextResponse.json({ ...message, delivery }, { status: 201 });
  } catch (error) {
    logger.error("Failed to create message:", error);
    return toErrorResponse(error);
  }
}
