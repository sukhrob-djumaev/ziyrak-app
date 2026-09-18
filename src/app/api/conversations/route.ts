import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as conversationsService from "@/lib/conversations/service";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "conversations:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);

    const { conversations, total } = await conversationsService.list(ctx, {
      channel: searchParams.get("channel"),
      status: searchParams.get("status"),
      search: searchParams.get("search"),
      skip,
      take,
    });

    return NextResponse.json(paginatedResponse(conversations, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch conversations:", error);
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "conversations:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { channel, customerName, customerContact, status } = body;

    if (!channel || typeof channel !== "string") {
      return NextResponse.json(
        { error: "Channel is required" },
        { status: 400 }
      );
    }

    const conversation = await conversationsService.create(ctx, { channel, customerName, customerContact, status });

    return NextResponse.json(conversation, { status: 201 });
  } catch (error) {
    logger.error("Failed to create conversation:", error);
    return toErrorResponse(error);
  }
}
