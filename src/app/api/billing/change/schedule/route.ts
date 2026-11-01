import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { scheduleReduction } from "@/lib/billing/changes";
import { getPaymentProvider, billingMode } from "@/lib/billing/providers";
import { AppError, toErrorResponse } from "@/lib/observability/errors";

/** L5.2 - schedules removals/decreases for period end. Owner only; nothing is taken away before the paid period ends. */
export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "business:billing");
  if (!isAuthenticated(ctx)) return ctx;
  try {
    if (ctx.actor.kind !== "user") throw new AppError(403, "FORBIDDEN", "Only the workspace owner can change the subscription");
    const provider = getPaymentProvider();
    if (!provider) throw new AppError(404, "NOT_FOUND", "Online payment is not available");
    const actor = { businessId: ctx.businessId, userId: ctx.actor.userId };
    const body = await request.json().catch(() => null);
    const out = await scheduleReduction(actor, body, { provider, mode: billingMode() });
    const response = NextResponse.json(out ?? { ok: true });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}
