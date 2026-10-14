import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { jobQueue } from "@/lib/jobs/queue";
import { SEND_FOLLOWUP_JOB, type SendFollowupPayload } from "@/lib/jobs/job-types";
import {
  ensureDelivery,
  dispatchDelivery,
  DeliveryBusyError,
  DeliveryRefusedError,
  projectDeliveryStatus,
} from "@/lib/conversations/delivery";
import { NotFoundError } from "@/lib/observability/errors";

export async function handleSendFollowup(
  ctx: TenantContext,
  payload: SendFollowupPayload
): Promise<void> {
  if (payload.businessId !== ctx.businessId) throw new NotFoundError("Follow-up");
  const db = getScopedPrisma(ctx);
  // Lock the durable action while creating its operation. Erasure takes the
  // same lock before redacting operations, so queued payloads cannot restore PII.
  const op = await db.$transaction(async (tx) => {
    const action = await tx.actionExecution.findUnique({
      where: {
        businessId_idempotencyKey: {
          businessId: ctx.businessId,
          idempotencyKey: payload.idempotencyKey,
        },
      },
    });
    if (!action || action.tool !== "schedule_followup") throw new NotFoundError("Follow-up");
    if (action.status === "succeeded" || action.status === "cancelled") return null;
    if (action.status === "running")
      throw new DeliveryBusyError("Scheduling is not yet recorded as complete.");
    if (action.conversationId && action.conversationId !== payload.conversationId)
      throw new NotFoundError("Follow-up");
    const input = action.input as Record<string, unknown>;
    if (input.message !== payload.message) throw new NotFoundError("Follow-up");
    const locked = await tx.actionExecution.updateMany({
      where: { id: action.id, status: action.status, updatedAt: action.updatedAt },
      data: { status: action.status },
    });
    if (!locked.count) throw new DeliveryBusyError("Follow-up changed while being claimed.");
    return ensureDelivery(
      ctx,
      {
        operationKey: "followup:" + action.id,
        kind: "followup",
        actionId: action.id,
        conversationId: payload.conversationId,
        channel: payload.channel,
        connectionId: payload.connectionId,
        recipient: payload.to,
        response: payload.message,
      },
      tx
    );
  });
  if (!op) return;
  const result = await dispatchDelivery(ctx, op.id);
  await projectDeliveryStatus(ctx, op.id);
  if (result.status === "rejected" && result.retryable) throw new DeliveryRefusedError(true);
}
jobQueue.registerHandler<SendFollowupPayload>(SEND_FOLLOWUP_JOB, handleSendFollowup);
