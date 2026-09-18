import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as ticketsService from "@/lib/tickets/service";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "tickets:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const ticket = await ticketsService.getById(ctx, id);
    return NextResponse.json(ticket);
  } catch (error) {
    logger.error("Failed to fetch ticket:", error);
    return toErrorResponse(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "tickets:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const body = await request.json();
    const { title, description, status, priority, resolution, departmentId, assignedToId, conversationId } = body;

    const ticket = await ticketsService.update(ctx, id, {
      title,
      description,
      status,
      priority,
      resolution,
      departmentId,
      assignedToId,
      conversationId,
    });

    return NextResponse.json(ticket);
  } catch (error) {
    logger.error("Failed to update ticket:", error);
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "tickets:delete");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    await ticketsService.remove(ctx, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete ticket:", error);
    return toErrorResponse(error);
  }
}
