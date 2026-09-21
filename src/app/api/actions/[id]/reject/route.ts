import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import { toolRegistry } from "@/lib/tools/registry";

/** PLAN.md §23.4/§46.6 — rejects a `pending_approval` ActionExecution; no side effect ever ran, so this is purely a status transition to `cancelled`. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "actions:approve");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    await toolRegistry.reject(ctx, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to reject action execution:", error);
    return toErrorResponse(error);
  }
}
