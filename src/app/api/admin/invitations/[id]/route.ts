import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import { logger } from "@/lib/observability/logger";
import { revokeInvitation } from "@/lib/platform/admin-users/invitations";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(request, "admin:delete");
  if (!isAuthenticated(ctx)) return ctx;
  try {
    await revokeInvitation(ctx, (await params).id);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to revoke invitation:", error);
    return toErrorResponse(error);
  }
}
