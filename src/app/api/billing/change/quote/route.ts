import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { quoteUpgrade } from "@/lib/billing/changes";
import { getPaymentProvider, billingMode } from "@/lib/billing/providers";
import { AppError, toErrorResponse } from "@/lib/observability/errors";

/** L5.2 - prices an upgrade (add-on or higher quantity) on the live subscription. Read-only; bound to the change by `quoteHash`. */
export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "business:billing");
  if (!isAuthenticated(ctx)) return ctx;
  try {
    const provider = getPaymentProvider();
    if (!provider) throw new AppError(404, "NOT_FOUND", "Online payment is not available");
    const quote = await quoteUpgrade(ctx.businessId, await request.json().catch(() => null), { provider, mode: billingMode() });
    const response = NextResponse.json(quote);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}
