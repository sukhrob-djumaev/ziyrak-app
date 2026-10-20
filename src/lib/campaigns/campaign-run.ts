import type { Prisma } from "@/generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { captureDeferredIdentity } from "@/lib/tenancy/deferred-origin";
import { hasPermission } from "@/lib/rbac/rbac";
import { AppError, NotFoundError } from "@/lib/observability/errors";
import { jobQueue } from "@/lib/jobs/queue";
import { EXECUTE_CAMPAIGN_JOB, type ExecuteCampaignPayload } from "@/lib/jobs/job-types";
import { currentCampaignFacts } from "./campaign-authority";
import { findTargetCustomers, type CampaignSegment } from "./campaigns";

/**
 * Creates the frozen, authorized run for one campaign execution. The requester's identity
 * ceiling, the message, the connection and the target ids are saved here; the worker sends only
 * this copy, and rechecks the requester at every recipient's sending admission.
 */
export async function startCampaignRun(ctx: TenantContext, campaignId: string) {
  if (
    !["user", "api_key"].includes(ctx.actor.kind) ||
    !ctx.role ||
    !hasPermission(ctx.role, "automation:create")
  )
    throw new AppError(
      403,
      "FORBIDDEN",
      "Starting a campaign requires a signed-in authorized person"
    );
  const db = getScopedPrisma(ctx);
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new NotFoundError("Campaign");
  const connection = await db.channelConnection.findFirst({
    where: { type: campaign.channel, isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (!connection)
    throw new AppError(
      409,
      "NO_CONNECTION",
      "No active connection exists for this campaign's channel"
    );
  const customers = await findTargetCustomers(
    ctx,
    campaign.segments as unknown as CampaignSegment[]
  );
  const snapshot = await captureDeferredIdentity(ctx);
  // The requester must already satisfy the exact conditions the worker will recheck.
  await currentCampaignFacts(ctx.businessId, snapshot, connection.id);
  const run = await db.$transaction(async (tx) => {
    // Locking the campaign row (and the workspace fence it takes) serializes simultaneous
    // starts: only one can observe "no active run" and create one.
    const locked = await tx.campaign.updateMany({
      where: { id: campaignId },
      data: { id: campaignId },
    });
    if (!locked.count) throw new NotFoundError("Campaign");
    const active = await tx.campaignRun.findFirst({
      where: { campaignId, status: { in: ["pending", "running"] }, retiredAt: null },
      select: { id: true },
    });
    if (active)
      throw new AppError(409, "CAMPAIGN_RUN_ACTIVE", "This campaign is already being sent");
    return tx.campaignRun.create({
      data: {
        businessId: ctx.businessId,
        campaignId,
        authorizationSnapshot: snapshot as Prisma.InputJsonValue,
        channel: campaign.channel,
        connectionId: connection.id,
        message: campaign.message,
        targetCustomerIds: customers.map((customer) => customer.id),
      },
    });
  });
  try {
    await jobQueue.enqueue<ExecuteCampaignPayload>(EXECUTE_CAMPAIGN_JOB, {
      businessId: ctx.businessId,
      runId: run.id,
    });
  } catch (error) {
    // Nothing was queued, so nothing will send: release the campaign for another attempt.
    await db.campaignRun.updateMany({ where: { id: run.id }, data: { status: "cancelled" } });
    throw error;
  }
  return { runId: run.id, targetCount: customers.length };
}
