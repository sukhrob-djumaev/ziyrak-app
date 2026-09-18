import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { findTargetCustomers, type CampaignSegment } from "@/lib/campaigns/campaigns";
import { logger } from "@/lib/observability/logger";
import { toErrorResponse } from "@/lib/observability/errors";
import * as campaignsService from "@/lib/campaigns/campaign-crud/service";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "automation:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;

    const campaign = await campaignsService.getById(ctx, id);

    const customers = await findTargetCustomers(
      ctx,
      campaign.segments as unknown as CampaignSegment[]
    );

    return NextResponse.json({
      campaignId: id,
      targetCount: customers.length,
    });
  } catch (error) {
    logger.error("Failed to execute campaign:", error);
    return toErrorResponse(error);
  }
}
