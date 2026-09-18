import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as teamService from "@/lib/team/service";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "team:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const body = await request.json();
    const { name, description, email } = body;

    if (!name || !name.trim()) {
      return NextResponse.json(
        { error: "Department name is required" },
        { status: 400 }
      );
    }

    const department = await teamService.updateDepartment(ctx, id, { name, description, email });

    return NextResponse.json(department);
  } catch (error) {
    logger.error("Failed to update department:", error);
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "team:delete");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    await teamService.removeDepartment(ctx, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete department:", error);
    return toErrorResponse(error);
  }
}
