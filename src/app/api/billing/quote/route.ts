import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { quoteCheckout } from "@/lib/billing/checkout";
import { getPaymentProvider, billingMode } from "@/lib/billing/providers";
import { AppError } from "@/lib/observability/errors";
import { toErrorResponse } from "@/lib/observability/errors";

/** L5.1 - prices a cart for the workspace owner. Read-only; the price shown is bound to the checkout by `quoteHash`. */
export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "business:billing");
  if (!isAuthenticated(ctx)) return ctx;
  try {
    const provider = getPaymentProvider();
    if (!provider) throw new AppError(404, "NOT_FOUND", "Online payment is not available");
    const quote = await quoteCheckout(ctx.businessId, await request.json().catch(() => null), { provider, mode: billingMode() });
    const response = NextResponse.json(quote);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}
