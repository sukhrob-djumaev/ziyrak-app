import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { getBillingStatus } from "@/lib/billing/status-view";
import { getPaymentProvider, billingMode } from "@/lib/billing/providers";
import { toErrorResponse } from "@/lib/observability/errors";

/** L5.1 - subscription state, hold state and what can be bought now, for the owner's billing page. Never cached. */
export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "business:billing");
  if (!isAuthenticated(ctx)) return ctx;
  try {
    const provider = getPaymentProvider();
    const response = NextResponse.json(await getBillingStatus(ctx.businessId, provider && { name: provider.name, mode: billingMode() }));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}
