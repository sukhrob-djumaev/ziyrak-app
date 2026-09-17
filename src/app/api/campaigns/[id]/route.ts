import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { toErrorResponse } from "@/lib/errors";
import * as campaignsService from "@/lib/campaign-crud/service";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "analytics:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const campaign = await campaignsService.getById(ctx, id);
    return NextResponse.json(campaign);
  } catch (error) {
    logger.error("Failed to fetch campaign:", error);
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
    const { name, description, channel, message, subject, segments, status, scheduledAt } = body;

    const campaign = await campaignsService.update(ctx, id, {
      name,
      description,
      channel,
      message,
      subject,
      segments,
      status,
      scheduledAt,
    });

    return NextResponse.json(campaign);
  } catch (error) {
    logger.error("Failed to update campaign:", error);
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
    await campaignsService.remove(ctx, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete campaign:", error);
    return toErrorResponse(error);
  }
}
