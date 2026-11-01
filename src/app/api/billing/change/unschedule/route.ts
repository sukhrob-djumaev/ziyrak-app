import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { cancelReduction } from "@/lib/billing/changes";
import { AppError, toErrorResponse } from "@/lib/observability/errors";

/** L5.2 - withdraws a scheduled reduction. Owner only; nothing is taken away before the paid period ends. */
export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "business:billing");
  if (!isAuthenticated(ctx)) return ctx;
  try {
    if (ctx.actor.kind !== "user") throw new AppError(403, "FORBIDDEN", "Only the workspace owner can change the subscription");
    const actor = { businessId: ctx.businessId, userId: ctx.actor.userId };
    const body = await request.json().catch(() => null);
    const out = await cancelReduction(actor, { versionId: typeof (body as { versionId?: unknown })?.versionId === "string" ? (body as { versionId: string }).versionId : "" });
    const response = NextResponse.json(out ?? { ok: true });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}
