import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import { validateBody, updateWebChatConnectionSchema } from "@/lib/validations";
import { updateWebChatConnection } from "@/lib/channels/webchat-connections-service";
import { logger } from "@/lib/observability/logger";

type RouteContext = { params: Promise<{ connectionId: string }> };

export async function PATCH(request: NextRequest, context: RouteContext) {
  const ctx = await requireAuth(request, "channels:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { connectionId } = await context.params;
    const body = await request.json().catch(() => ({}));
    const validation = validateBody(updateWebChatConnectionSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const updated = await updateWebChatConnection(ctx, connectionId, validation.data);
    return NextResponse.json(updated);
  } catch (error) {
    logger.error("Failed to update web chat connection:", error);
    return toErrorResponse(error);
  }
}
