import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { toErrorResponse } from "@/lib/errors";
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
    const { name, description, icon, color, sortOrder } = body;

    const category = await knowledgeService.updateCategory(ctx, id, { name, description, icon, color, sortOrder });

    return NextResponse.json(category);
  } catch (error) {
    logger.error("Failed to update category:", error);
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
    await knowledgeService.removeCategory(ctx, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete category:", error);
    return toErrorResponse(error);
  }
}
