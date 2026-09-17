import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { toErrorResponse } from "@/lib/errors";
import * as flowsService from "@/lib/flows/service";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "automation:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const flow = await flowsService.getById(ctx, id);
    return NextResponse.json(flow);
  } catch (error) {
    logger.error("Failed to fetch flow:", error);
    return toErrorResponse(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "automation:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const body = await request.json();
    const { name, description, startNodeId, nodes, isActive } = body;

    const flow = await flowsService.update(ctx, id, { name, description, startNodeId, nodes, isActive });

    return NextResponse.json(flow);
  } catch (error) {
    logger.error("Failed to update flow:", error);
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "automation:delete");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    await flowsService.remove(ctx, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete flow:", error);
    return toErrorResponse(error);
  }
}
