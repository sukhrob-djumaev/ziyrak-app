import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { startUpgrade } from "@/lib/billing/changes";
import { getPaymentProvider, billingMode } from "@/lib/billing/providers";
import { AppError, toErrorResponse } from "@/lib/observability/errors";

/** L5.2 - applies an upgrade for the workspace owner. Access follows the provider's confirmation, not this request. */
export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "business:billing");
  if (!isAuthenticated(ctx)) return ctx;
  try {
    // The payer is the signed-in owner; API keys and platform support sessions never change a subscription.
    if (ctx.actor.kind !== "user") throw new AppError(403, "FORBIDDEN", "Only the workspace owner can change the subscription");
    const provider = getPaymentProvider();
    if (!provider) throw new AppError(404, "NOT_FOUND", "Online payment is not available");
    const out = await startUpgrade({ businessId: ctx.businessId, userId: ctx.actor.userId }, await request.json().catch(() => null), { provider, mode: billingMode() });
    const response = NextResponse.json(out);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}
