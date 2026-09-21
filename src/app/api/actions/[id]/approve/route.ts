import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import { toolRegistry } from "@/lib/tools/registry";

/**
 * PLAN.md §23.4/§9.5/§46.6 — the human side of the approval-gated
 * execution path: a `pending_approval` `ActionExecution` (created when the
 * AI called a `requiresHumanApproval` tool, §23.4) performs no side effect
 * until a human with `actions:approve` hits this route. `ToolRegistry.
 * approve()` itself re-validates the record is still `pending_approval`
 * and tenant-scoped (via `getScopedPrisma(ctx)`) before running anything.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "actions:approve");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const result = await toolRegistry.approve(ctx, id);
    return NextResponse.json(result);
  } catch (error) {
    logger.error("Failed to approve action execution:", error);
    return toErrorResponse(error);
  }
}
