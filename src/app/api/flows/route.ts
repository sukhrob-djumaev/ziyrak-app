import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as flowsService from "@/lib/flows/service";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "automation:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);
    const isActive = searchParams.get("isActive");

    const { flows, total } = await flowsService.list(ctx, { isActive, skip, take });

    return NextResponse.json(paginatedResponse(flows, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch flows:", error);
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "automation:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { name, description, startNodeId, nodes, isActive } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }

    const flow = await flowsService.create(ctx, { name, description, startNodeId, nodes, isActive });

    return NextResponse.json(flow, { status: 201 });
  } catch (error) {
    logger.error("Failed to create flow:", error);
    return toErrorResponse(error);
  }
}
