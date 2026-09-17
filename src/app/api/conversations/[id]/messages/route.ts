import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { toErrorResponse } from "@/lib/errors";
import { emitNewMessage } from "@/lib/realtime";
import * as conversationsService from "@/lib/conversations/service";

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

    return NextResponse.json(message, { status: 201 });
  } catch (error) {
    logger.error("Failed to create message:", error);
    return toErrorResponse(error);
  }
}
