import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { toErrorResponse } from "@/lib/errors";
import * as connectionsService from "@/lib/channels/connections-service";

type RouteContext = { params: Promise<{ type: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const ctx = await requireAuth(request, "channels:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { type } = await context.params;

    if (!connectionsService.isValidChannelType(type)) {
      return NextResponse.json(
        { error: "Invalid channel type" },
        { status: 400 }
      );
    }

    const channel = await connectionsService.getByType(ctx, type);
    return NextResponse.json(channel);
  } catch (error) {
    logger.error("Failed to fetch channel:", error);
    return toErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const ctx = await requireAuth(request, "channels:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { type } = await context.params;

    if (!connectionsService.isValidChannelType(type)) {
      return NextResponse.json(
        { error: "Invalid channel type" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { isActive, config, status } = body;

    const channel = await connectionsService.upsertByType(ctx, type, { isActive, config, status });

    return NextResponse.json(channel);
  } catch (error) {
    logger.error("Failed to update channel:", error);
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const ctx = await requireAuth(request, "channels:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { type } = await context.params;

    if (!connectionsService.isValidChannelType(type)) {
      return NextResponse.json(
        { error: "Invalid channel type" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { action } = body;

    if (!action || !["connect", "disconnect", "test"].includes(action)) {
      return NextResponse.json(
        { error: "Invalid action. Must be one of: connect, disconnect, test" },
        { status: 400 }
      );
    }

    const result = await connectionsService.performAction(ctx, type, action);

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    if ("success" in result) {
      return NextResponse.json({
        success: true,
        message: `${type} connection test initiated`,
        channel: result.connection,
      });
    }

    return NextResponse.json({ ...result, message: `${type} channel ${action}ed` });
  } catch (error) {
    logger.error("Failed to perform channel action:", error);
    return toErrorResponse(error);
  }
}
