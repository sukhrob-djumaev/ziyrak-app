import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as campaignsService from "@/lib/campaigns/campaign-crud/service";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "analytics:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);
    const status = searchParams.get("status");
    const channel = searchParams.get("channel");

    const { campaigns, total } = await campaignsService.list(ctx, { status, channel, skip, take });

    return NextResponse.json(paginatedResponse(campaigns, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch campaigns:", error);
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "automation:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { name, description, channel, message, subject, segments, scheduledAt } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

    const campaign = await campaignsService.create(ctx, { name, description, channel, message, subject, segments, scheduledAt });

    return NextResponse.json(campaign, { status: 201 });
  } catch (error) {
    logger.error("Failed to create campaign:", error);
    return toErrorResponse(error);
  }
}
