import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as automationService from "@/lib/automations/automation-rules/service";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "automation:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const body = await request.json();
    const { name, description, type, isActive, conditions, actions, priority } = body;

    const validTypes = ["auto_route", "auto_tag", "auto_reply", "keyword_alert"];
    if (type !== undefined && !validTypes.includes(type)) {
      return NextResponse.json(
        { error: "Invalid rule type" },
        { status: 400 }
      );
    }

    const rule = await automationService.update(ctx, id, { name, description, type, isActive, conditions, actions, priority });

    return NextResponse.json(rule);
  } catch (error) {
    logger.error("Failed to update automation rule:", error);
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
    await automationService.remove(ctx, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete automation rule:", error);
    return toErrorResponse(error);
  }
}
