import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import { logger } from "@/lib/observability/logger";
import { listInvitations } from "@/lib/platform/admin-users/invitations";

/** PLAN.md P3 — pending invitations of the caller's own workspace. */
export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "admin:read");
  if (!isAuthenticated(ctx)) return ctx;
  try {
    return NextResponse.json({ data: await listInvitations(ctx) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logger.error("Failed to list invitations:", error);
    return toErrorResponse(error);
  }
}
