import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { startCampaignRun } from "@/lib/campaigns/campaign-run";
import { logger } from "@/lib/observability/logger";
import { toErrorResponse } from "@/lib/observability/errors";

/**
 * PLAN.md §25.2/§46.6 PR3 task 15 — durably enqueues the send rather than
 * only counting targets (§2.4's own finding: this route never sent
 * anything). `targetCount` is still returned immediately, computed the
 * same way it always was, so the dashboard's existing "X customers will
 * be messaged" confirmation UX needs no change — the difference is that a
 * real `execute-campaign` job now actually sends to every one of them.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(request, "automation:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;

    const { runId, targetCount } = await startCampaignRun(ctx, id);

    return NextResponse.json({
      campaignId: id,
      runId,
      targetCount,
    });
  } catch (error) {
    logger.error("Failed to execute campaign:", error);
    return toErrorResponse(error);
  }
}
