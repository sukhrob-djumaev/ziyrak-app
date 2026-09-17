import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { toErrorResponse } from "@/lib/errors";
import * as webhooksService from "@/lib/webhooks/service";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "webhooks:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const webhook = await webhooksService.getById(ctx, id);
    return NextResponse.json(webhook);
  } catch (error) {
    logger.error("Failed to fetch webhook:", error);
    return toErrorResponse(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "webhooks:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const body = await request.json();
    const { name, description, url, method, headers, triggerOn, isActive } = body;

    const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    if (method && !validMethods.includes(method)) {
      return NextResponse.json(
        { error: `Invalid method. Must be one of: ${validMethods.join(", ")}` },
        { status: 400 }
      );
    }

    if (url && typeof url === "string" && !url.startsWith("http")) {
      return NextResponse.json({ error: "URL must start with http:// or https://" }, { status: 400 });
    }

    const webhook = await webhooksService.update(ctx, id, {
      name,
      description,
      url,
      method,
      headers,
      triggerOn,
      isActive,
    });

    return NextResponse.json(webhook);
  } catch (error) {
    logger.error("Failed to update webhook:", error);
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "webhooks:delete");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    await webhooksService.remove(ctx, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error("Failed to delete webhook:", error);
    return toErrorResponse(error);
  }
}
