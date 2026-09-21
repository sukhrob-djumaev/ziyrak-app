import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import { validateBody, createWebChatConnectionSchema } from "@/lib/validations";
import { listWebChatConnections, createWebChatConnection } from "@/lib/channels/webchat-connections-service";
import { logger } from "@/lib/observability/logger";

/**
 * PLAN.md §20.4/§46.7 — admin-authenticated management of a business's own
 * Web Chat connections. Lives at `/api/channels/webchat-connections`, not
 * under `/api/channels/webchat/...`, on purpose: that prefix is the
 * *public*, token-authenticated widget surface (`public-api-paths.ts`), and
 * an admin route must never be classified as public by prefix match.
 */
export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "channels:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const connections = await listWebChatConnections(ctx);
    return NextResponse.json({ data: connections });
  } catch (error) {
    logger.error("Failed to list web chat connections:", error);
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "channels:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json().catch(() => ({}));
    const validation = validateBody(createWebChatConnectionSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // The token is returned in this response only — never retrievable again
    // (rotate it instead), matching an ApiKey secret's show-once contract (§9.4).
    const created = await createWebChatConnection(ctx, validation.data);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    logger.error("Failed to create web chat connection:", error);
    return toErrorResponse(error);
  }
}
