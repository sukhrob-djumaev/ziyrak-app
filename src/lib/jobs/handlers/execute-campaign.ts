import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { findTargetCustomers, sendProactiveMessage, type CampaignSegment } from "@/lib/campaigns/campaigns";
import { jobQueue } from "@/lib/jobs/queue";
import { EXECUTE_CAMPAIGN_JOB, type ExecuteCampaignPayload } from "@/lib/jobs/job-types";
import { logger } from "@/lib/observability/logger";

/**
 * PLAN.md §25.2/§46.6 PR3 task 15 — replaces `POST /api/campaigns/:id/
 * execute`'s target-count-only behavior (§2.4 — it only ever counted
 * matched customers, never sent anything) with a durable, per-customer
 * fan-out: one `sendProactiveMessage` attempt per matched customer, each
 * in its own try/catch so one customer's failure never stops the rest
 * (§31.3's "a single [unit] down must not affect other" principle,
 * applied here to campaign recipients the same way it already applies to
 * channels and businesses), with per-customer success/failure tracked
 * rather than only an aggregate count.
 */
export async function handleExecuteCampaign(ctx: TenantContext, payload: ExecuteCampaignPayload): Promise<void> {
  const db = getScopedPrisma(ctx);

  const campaign = await db.campaign.findUnique({ where: { id: payload.campaignId } });
  if (!campaign) {
    logger.warn("[execute-campaign] campaign no longer exists, skipping", { businessId: ctx.businessId, campaignId: payload.campaignId });
    return;
  }

  await db.campaign.update({ where: { id: campaign.id }, data: { status: "running" } });

  const connection = await db.channelConnection.findFirst({ where: { type: campaign.channel, isActive: true } });
  if (!connection) {
    await db.campaign.update({ where: { id: campaign.id }, data: { status: "paused" } });
    logger.error("[execute-campaign] no active connection for channel, campaign paused", {
      businessId: ctx.businessId,
      campaignId: campaign.id,
      channel: campaign.channel,
    });
    return;
  }

  const customers = await findTargetCustomers(ctx, campaign.segments as unknown as CampaignSegment[]);

  let sent = 0;
  let failed = 0;
  for (const customer of customers) {
    try {
      const result = await sendProactiveMessage(ctx, customer.id, campaign.channel, connection.id, campaign.message);
      if (result.success) {
        sent++;
      } else {
        failed++;
        logger.warn("[execute-campaign] send failed for one customer", {
          businessId: ctx.businessId,
          campaignId: campaign.id,
          customerId: customer.id,
          error: result.error,
        });
      }
    } catch (error) {
      failed++;
      logger.error("[execute-campaign] unexpected error sending to one customer", {
        businessId: ctx.businessId,
        campaignId: campaign.id,
        customerId: customer.id,
        error,
      });
    }
  }

  await db.campaign.update({ where: { id: campaign.id }, data: { status: "completed", sentCount: sent } });

  logger.info("[execute-campaign] campaign complete", {
    businessId: ctx.businessId,
    campaignId: campaign.id,
    targeted: customers.length,
    sent,
    failed,
  });
}

jobQueue.registerHandler<ExecuteCampaignPayload>(EXECUTE_CAMPAIGN_JOB, handleExecuteCampaign);
