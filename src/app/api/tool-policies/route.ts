import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import { hasPermission } from "@/lib/rbac/rbac";
import { listToolPolicies } from "@/lib/tools/policy-admin";
import "@/lib/tools/builtin";

/** PLAN.md §23.4 — lists each AI tool with this business's effective policy. */
export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "tools:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    // `canEdit` lets the UI show read-only controls to roles that may only look.
    return NextResponse.json({ data: await listToolPolicies(ctx), canEdit: hasPermission(ctx.role ?? "", "tools:update") });
  } catch (error) {
    logger.error("Failed to list tool policies:", error);
    return toErrorResponse(error);
  }
}
