import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import { rotateWebChatToken } from "@/lib/channels/webchat-connections-service";
import { logger } from "@/lib/observability/logger";

type RouteContext = { params: Promise<{ connectionId: string }> };

/**
 * PLAN.md §20.4/§46.7 acceptance criterion — "A business can rotate its Web
 * Chat widget token without any other channel or admin credential being
 * affected": this only ever rewrites this one connection's own
 * `credentialRef`; no ApiKey, JWT, or other ChannelConnection is touched.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const ctx = await requireAuth(request, "channels:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { connectionId } = await context.params;
    const rotated = await rotateWebChatToken(ctx, connectionId);
    return NextResponse.json(rotated);
  } catch (error) {
    logger.error("Failed to rotate web chat token:", error);
    return toErrorResponse(error);
  }
}
