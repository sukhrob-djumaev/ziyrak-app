import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { toErrorResponse } from "@/lib/errors";
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
    const { name, email, phone, role, expertise, departmentId, isAvailable } = body;

    if (!name || !name.trim()) {
      return NextResponse.json(
        { error: "Member name is required" },
        { status: 400 }
      );
    }

    if (!email || !email.trim()) {
      return NextResponse.json(
        { error: "Member email is required" },
        { status: 400 }
      );
    }

    if (!departmentId) {
      return NextResponse.json(
        { error: "Department is required" },
        { status: 400 }
      );
    }

    const member = await teamService.updateMember(ctx, id, {
      name,
      email,
      phone,
      role,
      expertise,
      departmentId,
      isAvailable,
    });

    return NextResponse.json(member);
  } catch (error) {
    logger.error("Failed to update member:", error);
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
    await teamService.removeMember(ctx, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete member:", error);
    return toErrorResponse(error);
  }
}
