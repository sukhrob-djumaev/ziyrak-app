import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { startCheckout } from "@/lib/billing/checkout";
import { getPaymentProvider, billingMode } from "@/lib/billing/providers";
import { AppError, toErrorResponse } from "@/lib/observability/errors";

/** L5.1 - starts hosted checkout for the workspace owner. Grants nothing: access follows the confirmed subscription. */
export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "business:billing");
  if (!isAuthenticated(ctx)) return ctx;
  try {
    // The payer is the signed-in owner; API keys and platform support sessions never start a purchase.
    if (ctx.actor.kind !== "user") throw new AppError(403, "FORBIDDEN", "Only the workspace owner can start a subscription");
    const provider = getPaymentProvider();
    if (!provider) throw new AppError(404, "NOT_FOUND", "Online payment is not available");
    const out = await startCheckout({ businessId: ctx.businessId, userId: ctx.actor.userId }, await request.json().catch(() => null), { provider, mode: billingMode() });
    const response = NextResponse.json(out);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}
