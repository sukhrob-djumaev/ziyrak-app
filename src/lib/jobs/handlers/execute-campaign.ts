import type { CampaignRun } from "@/generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { authorizeCampaignSubmission } from "@/lib/campaigns/campaign-authority";
import { jobQueue } from "@/lib/jobs/queue";
import { EXECUTE_CAMPAIGN_JOB, type ExecuteCampaignPayload } from "@/lib/jobs/job-types";
import {
  DeliveryBusyError,
  dispatchDelivery,
  ensureDelivery,
  prepareDelivery,
} from "@/lib/conversations/delivery";
import { NotFoundError } from "@/lib/observability/errors";
import { logger } from "@/lib/observability/logger";

type Outcome = "attempted" | "skipped" | "failed";

/**
 * Sends one frozen campaign run. Every recipient has its own durable `DeliveryOperation`
 * (`campaign:<run>:<customer>`) that goes through the single sending admission, which rechecks
 * the requester's saved authority immediately before transport. A redelivered job, a second
 * worker or a retry after a crash can never send a recipient twice: an operation that was
 * claimed, accepted, rejected or left uncertain is never re-sent from here.
 */
async function sendToRecipient(
  ctx: TenantContext,
  run: CampaignRun,
  customerId: string
): Promise<Outcome> {
  const db = getScopedPrisma(ctx);
  const key = `campaign:${run.id}:${customerId}`;
  const existing = await db.deliveryOperation.findUnique({
    where: { businessId_operationKey: { businessId: ctx.businessId, operationKey: key } },
  });
  if (existing && !["pending", "ready"].includes(existing.status)) return "skipped";
  const customer = await db.customer.findUnique({ where: { id: customerId } });
  if (!customer) return "failed";
  const to =
    run.channel === "email"
      ? customer.email
      : run.channel === "whatsapp"
        ? customer.whatsapp
        : customer.phone;
  if (!to) return "failed";
  try {
    let op = await ensureDelivery(ctx, {
      operationKey: key,
      kind: "campaign",
      campaignRunId: run.id,
      channel: run.channel,
      connectionId: run.connectionId,
      recipient: to,
    });
    op = await prepareDelivery(ctx, op, async (recordConversation) => {
      const conversation = await db.conversation.create({
        data: {
          businessId: ctx.businessId,
          channel: run.channel,
          customerName: customer.name,
          customerContact: to,
          customerId,
          status: "active",
          metadata: { channelConnectionId: run.connectionId, campaignRunId: run.id },
        },
      });
      await recordConversation(conversation.id);
      return { conversationId: conversation.id, response: run.message };
    });
    await dispatchDelivery(ctx, op.id, undefined, authorizeCampaignSubmission);
    return "attempted";
  } catch (error) {
    if (error instanceof DeliveryBusyError) return "skipped";
    throw error;
  }
}

export async function handleExecuteCampaign(
  ctx: TenantContext,
  payload: ExecuteCampaignPayload
): Promise<void> {
  if (ctx.businessId !== payload.businessId) throw new NotFoundError("Campaign run");
  const db = getScopedPrisma(ctx);
  if (typeof payload.runId !== "string") {
    // A job queued before runs existed carried no frozen copy or saved authority.
    logger.warn("[execute-campaign] job has no saved run; nothing was sent", {
      businessId: ctx.businessId,
    });
    return;
  }
  const run = await db.campaignRun.findFirst({ where: { id: payload.runId, retiredAt: null } });
  if (!run || ["completed", "cancelled"].includes(run.status)) {
    logger.warn("[execute-campaign] run is unavailable or finished, skipping", {
      businessId: ctx.businessId,
      runId: payload.runId,
    });
    return;
  }
  await db.campaignRun.updateMany({
    where: { id: run.id, status: { in: ["pending", "running"] } },
    data: { status: "running" },
  });
  await db.campaign.updateMany({ where: { id: run.campaignId }, data: { status: "running" } });
  const targets = Array.isArray(run.targetCustomerIds) ? (run.targetCustomerIds as string[]) : [];
  let failed = 0;
  for (const customerId of targets) {
    try {
      if ((await sendToRecipient(ctx, run, customerId)) === "failed") failed++;
    } catch (error) {
      failed++;
      logger.error("[execute-campaign] unexpected error sending to one customer", {
        businessId: ctx.businessId,
        runId: run.id,
        customerId,
        error,
      });
    }
  }
  const accepted = await db.deliveryOperation.count({
    where: { campaignRunId: run.id, status: "accepted" },
  });
  await db.campaignRun.updateMany({ where: { id: run.id }, data: { status: "completed" } });
  await db.campaign.updateMany({
    where: { id: run.campaignId },
    data: { status: "completed", sentCount: accepted },
  });
  logger.info("[execute-campaign] run complete", {
    businessId: ctx.businessId,
    runId: run.id,
    targeted: targets.length,
    accepted,
    failed,
  });
}

jobQueue.registerHandler<ExecuteCampaignPayload>(EXECUTE_CAMPAIGN_JOB, handleExecuteCampaign);
