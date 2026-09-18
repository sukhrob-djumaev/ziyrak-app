import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as conversationsService from "@/lib/conversations/service";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "conversations:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const body = await request.json();
    const { rating } = body;

    if (!rating || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      return NextResponse.json(
        { error: "Rating must be an integer between 1 and 5" },
        { status: 400 }
      );
    }

    const conversation = await conversationsService.setSatisfaction(ctx, id, rating);

    return NextResponse.json({
      success: true,
      satisfaction: conversation.satisfaction,
    });
  } catch (error) {
    logger.error("Failed to update satisfaction:", error);
    return toErrorResponse(error);
  }
}
