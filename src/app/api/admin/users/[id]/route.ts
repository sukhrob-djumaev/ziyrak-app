import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { toErrorResponse } from "@/lib/errors";
import * as adminUsersService from "@/lib/admin-users/service";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "admin:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const body = await request.json();
    const { name, role, password } = body;

    const user = await adminUsersService.update(ctx, id, { name, role, password });

    return NextResponse.json(user);
  } catch (error) {
    logger.error("Failed to update admin user:", error);
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "admin:delete");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    await adminUsersService.remove(ctx, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete admin user:", error);
    return toErrorResponse(error);
  }
}
