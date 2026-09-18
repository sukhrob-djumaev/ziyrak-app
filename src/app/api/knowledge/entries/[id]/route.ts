import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as knowledgeService from "@/lib/knowledge/service";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "knowledge:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const body = await request.json();
    const { title, content, priority, isActive, categoryId } = body;

    const entry = await knowledgeService.updateEntry(ctx, id, { title, content, priority, isActive, categoryId });

    return NextResponse.json(entry);
  } catch (error) {
    logger.error("Failed to update entry:", error);
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "knowledge:delete");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    await knowledgeService.removeEntry(ctx, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete entry:", error);
    return toErrorResponse(error);
  }
}
