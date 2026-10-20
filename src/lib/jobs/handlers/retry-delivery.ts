import { authorizeCampaignSubmission } from "@/lib/campaigns/campaign-authority";
import { authorizeFollowupSubmission } from "@/lib/tools/followup-authority";
import { jobQueue } from "@/lib/jobs/queue";
import { RETRY_DELIVERY_JOB, type RetryDeliveryPayload } from "@/lib/jobs/job-types";
import type { TenantContext } from "@/lib/tenancy/context";
import {
  dispatchDelivery,
  DeliveryRefusedError,
  projectDeliveryStatus,
} from "@/lib/conversations/delivery";
import { NotFoundError } from "@/lib/observability/errors";
export async function handleRetryDelivery(ctx: TenantContext, payload: RetryDeliveryPayload) {
  if (ctx.businessId !== payload.businessId) throw new NotFoundError("Delivery");
  const op = await dispatchDelivery(
    ctx,
    payload.deliveryId,
    authorizeFollowupSubmission,
    authorizeCampaignSubmission
  );
  await projectDeliveryStatus(ctx, op.id);
  if (op.status === "rejected" && op.retryable) throw new DeliveryRefusedError(true);
}
jobQueue.registerHandler<RetryDeliveryPayload>(RETRY_DELIVERY_JOB, handleRetryDelivery);
