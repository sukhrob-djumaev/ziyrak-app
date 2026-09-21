import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { findTargetCustomers, type CampaignSegment } from "@/lib/campaigns/campaigns";
import { logger } from "@/lib/observability/logger";
import { toErrorResponse } from "@/lib/observability/errors";
import * as campaignsService from "@/lib/campaigns/campaign-crud/service";
import { jobQueue } from "@/lib/jobs/queue";
import { EXECUTE_CAMPAIGN_JOB, type ExecuteCampaignPayload } from "@/lib/jobs/job-types";

/**
 * PLAN.md §25.2/§46.6 PR3 task 15 — durably enqueues the send rather than
 * only counting targets (§2.4's own finding: this route never sent
 * anything). `targetCount` is still returned immediately, computed the
 * same way it always was, so the dashboard's existing "X customers will
 * be messaged" confirmation UX needs no change — the difference is that a
 * real `execute-campaign` job now actually sends to every one of them.
 */
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

    await jobQueue.enqueue<ExecuteCampaignPayload>(EXECUTE_CAMPAIGN_JOB, {
      businessId: ctx.businessId,
      campaignId: id,
    });

    return NextResponse.json({
      campaignId: id,
      targetCount: customers.length,
    });
  } catch (error) {
    logger.error("Failed to execute campaign:", error);
    return toErrorResponse(error);
  }
}
