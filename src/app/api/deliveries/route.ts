import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { listDeliveryRecovery } from "@/lib/conversations/delivery";
import { toErrorResponse } from "@/lib/observability/errors";
export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "actions:read");
  if (!isAuthenticated(ctx)) return ctx;
  try {
    return NextResponse.json({ data: await listDeliveryRecovery(ctx) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
