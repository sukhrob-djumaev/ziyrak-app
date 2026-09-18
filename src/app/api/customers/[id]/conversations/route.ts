import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as customersService from "@/lib/customers/service";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "customers:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);

    const { conversations, total } = await customersService.listConversations(ctx, id, {
      channel: searchParams.get("channel"),
      skip,
      take,
    });

    return NextResponse.json(paginatedResponse(conversations, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch customer conversations:", error);
    return toErrorResponse(error);
  }
}
