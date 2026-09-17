import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { toErrorResponse } from "@/lib/errors";
import * as connectionsService from "@/lib/channels/connections-service";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "channels:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const result = await connectionsService.listAll(ctx);
    return NextResponse.json(result);
  } catch (error) {
    logger.error("Failed to fetch channels:", error);
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "channels:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { type, isActive, config } = body;

    if (!type || !connectionsService.isValidChannelType(type)) {
      return NextResponse.json(
        { error: "Invalid channel type" },
        { status: 400 }
      );
    }

    const channel = await connectionsService.upsertByType(ctx, type, { isActive, config });

    return NextResponse.json(channel, { status: 200 });
  } catch (error) {
    logger.error("Failed to save channel:", error);
    return toErrorResponse(error);
  }
}
