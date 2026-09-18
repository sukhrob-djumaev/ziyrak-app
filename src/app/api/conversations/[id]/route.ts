import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import { emitConversationUpdate } from "@/lib/realtime/realtime";
import * as conversationsService from "@/lib/conversations/service";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "conversations:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const conversation = await conversationsService.getById(ctx, id);
    return NextResponse.json(conversation);
  } catch (error) {
    logger.error("Failed to fetch conversation:", error);
    return toErrorResponse(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "conversations:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const body = await request.json();
    const { status, customerName, customerContact, summary, satisfaction, tagIds } = body;

    const validStatuses = ["active", "resolved", "closed", "escalated", "snoozed"];
    if (status !== undefined && !validStatuses.includes(status)) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` },
        { status: 400 }
      );
    }

    if (satisfaction !== undefined && satisfaction !== null) {
      if (!Number.isInteger(satisfaction) || satisfaction < 1 || satisfaction > 5) {
        return NextResponse.json(
          { error: "Satisfaction must be an integer between 1 and 5" },
          { status: 400 }
        );
      }
    }

    const conversation = await conversationsService.update(ctx, id, {
      status,
      customerName,
      customerContact,
      summary,
      satisfaction,
      tagIds,
    });

    emitConversationUpdate(ctx.businessId, id, { status, customerName });

    return NextResponse.json(conversation);
  } catch (error) {
    logger.error("Failed to update conversation:", error);
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "conversations:delete");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    await conversationsService.remove(ctx, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete conversation:", error);
    return toErrorResponse(error);
  }
}
