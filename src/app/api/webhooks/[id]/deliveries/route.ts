import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { retryDelivery } from "@/lib/integrations/webhook-delivery";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as webhooksService from "@/lib/integrations/webhooks/service";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "webhooks:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);
    const status = searchParams.get("status");

    const { deliveries, total } = await webhooksService.listDeliveries(ctx, id, { status, skip, take });

    return NextResponse.json(paginatedResponse(deliveries, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch webhook deliveries:", error);
    return toErrorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "webhooks:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const body = await request.json();
    const { deliveryId } = body;

    if (!deliveryId) {
      return NextResponse.json(
        { error: "deliveryId is required" },
        { status: 400 }
      );
    }

    const delivery = await webhooksService.findDeliveryForWebhook(ctx, id, deliveryId);

    if (!delivery) {
      return NextResponse.json(
        { error: "Delivery not found" },
        { status: 404 }
      );
    }

    const success = await retryDelivery(ctx, deliveryId);

    return NextResponse.json({ success, deliveryId });
  } catch (error) {
    logger.error("Failed to retry webhook delivery:", error);
    return toErrorResponse(error);
  }
}
