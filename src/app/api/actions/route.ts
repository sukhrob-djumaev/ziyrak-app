import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

/**
 * PLAN.md §23.4/§46.6 — lists `ActionExecution` rows for the dashboard's
 * pending-approval queue (`?status=pending_approval`) and general action
 * history. Read-only; approving/rejecting is `/api/actions/[id]/approve`
 * and `/api/actions/[id]/reject`.
 */
export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "actions:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);
    const status = searchParams.get("status");

    const db = getScopedPrisma(ctx);
    const where = status ? { status } : {};

    const [actions, total] = await Promise.all([
      db.actionExecution.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
      db.actionExecution.count({ where }),
    ]);

    return NextResponse.json(paginatedResponse(actions, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch action executions:", error);
    return toErrorResponse(error);
  }
}
