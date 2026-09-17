import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { toErrorResponse, NotFoundError } from "@/lib/errors";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "canned:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const body = await request.json();
    const { title, content, category, shortcut, isActive, usageCount } = body;

    const db = getScopedPrisma(ctx);
    const existing = await db.cannedResponse.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Canned response");

    const response = await db.cannedResponse.update({
      where: { id },
      data: {
        ...(title !== undefined && { title: title.trim() }),
        ...(content !== undefined && { content: content.trim() }),
        ...(category !== undefined && { category: category.trim() }),
        ...(shortcut !== undefined && { shortcut: shortcut.trim() }),
        ...(isActive !== undefined && { isActive }),
        ...(usageCount !== undefined && { usageCount }),
      },
    });

    return NextResponse.json(response);
  } catch (error) {
    logger.error("Failed to update canned response:", error);
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "canned:delete");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const db = getScopedPrisma(ctx);
    const existing = await db.cannedResponse.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Canned response");

    await db.cannedResponse.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete canned response:", error);
    return toErrorResponse(error);
  }
}
