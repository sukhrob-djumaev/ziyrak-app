import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { redactApiKeyHash } from "@/lib/security";
import { toErrorResponse } from "@/lib/errors";
import * as apiKeysService from "@/lib/admin-api-keys/service";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "admin:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const body = await request.json();
    const { name, isActive } = body;

    const apiKey = await apiKeysService.update(ctx, id, { name, isActive });

    // §9.4: keyHash is never returned — only keyPrefix, which is safe to
    // display since it isn't the secret itself.
    return NextResponse.json(redactApiKeyHash(apiKey));
  } catch (error) {
    logger.error("Failed to update API key:", error);
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
    await apiKeysService.remove(ctx, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete API key:", error);
    return toErrorResponse(error);
  }
}
