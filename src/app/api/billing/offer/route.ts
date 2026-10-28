import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { getOfferView } from "@/lib/billing/offer-view";
import { toErrorResponse } from "@/lib/observability/errors";

/** L4.1b - the workspace owner's read-only package view. Owner-only (`business:billing`); never cached. */
export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "business:billing");
  if (!isAuthenticated(ctx)) return ctx;
  try {
    const response = NextResponse.json(await getOfferView(ctx.businessId));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}
