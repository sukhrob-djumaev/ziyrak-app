import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { toErrorResponse, NotFoundError } from "@/lib/errors";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "sla:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const body = await request.json();
    const { name, description, channel, priority, firstResponseMins, resolutionMins, isActive } = body;

    const db = getScopedPrisma(ctx);
    const existing = await db.sLARule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("SLA rule");

    const rule = await db.sLARule.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(description !== undefined && { description: description.trim() }),
        ...(channel !== undefined && { channel }),
        ...(priority !== undefined && { priority }),
        ...(firstResponseMins !== undefined && { firstResponseMins }),
        ...(resolutionMins !== undefined && { resolutionMins }),
        ...(isActive !== undefined && { isActive }),
      },
    });

    return NextResponse.json(rule);
  } catch (error) {
    logger.error("Failed to update SLA rule:", error);
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "sla:delete");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const db = getScopedPrisma(ctx);
    const existing = await db.sLARule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("SLA rule");

    await db.sLARule.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete SLA rule:", error);
    return toErrorResponse(error);
  }
}
