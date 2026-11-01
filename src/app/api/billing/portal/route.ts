import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { openPortal } from "@/lib/billing/checkout";
import { getPaymentProvider } from "@/lib/billing/providers";
import { AppError, toErrorResponse } from "@/lib/observability/errors";

/** L5.1 - opens the provider's customer portal (payment method, invoices) for the workspace owner. */
export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "business:billing");
  if (!isAuthenticated(ctx)) return ctx;
  try {
    if (ctx.actor.kind !== "user") throw new AppError(403, "FORBIDDEN", "Only the workspace owner can manage payment details");
    const provider = getPaymentProvider();
    if (!provider) throw new AppError(404, "NOT_FOUND", "Online payment is not available");
    const { url } = await openPortal(ctx.businessId, provider);
    const response = NextResponse.json({ url });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}
