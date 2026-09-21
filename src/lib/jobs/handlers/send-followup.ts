import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { getChannelAdapter } from "@/lib/channels/registry";
import { jobQueue } from "@/lib/jobs/queue";
import { SEND_FOLLOWUP_JOB, type SendFollowupPayload } from "@/lib/jobs/job-types";
import { logger } from "@/lib/observability/logger";

/**
 * PLAN.md §24.3/§46.6 PR3 task 14 — the "real thing" `schedule_followup`
 * (`tools/builtin/schedule-followup.ts`) durably enqueues: the actual
 * outbound send, run once the job's `runAt` arrives. Updates the same
 * `ActionExecution` row the tool call created (`scheduled` at enqueue time)
 * to `succeeded`/`failed` once this actually runs — the dashboard's
 * conversation view can show "follow-up: scheduled → sent" (§24.3), not
 * only the AI's initial claim.
 */
export async function handleSendFollowup(ctx: TenantContext, payload: SendFollowupPayload): Promise<void> {
  const db = getScopedPrisma(ctx);

  const actionRow = await db.actionExecution.findUnique({
    where: { businessId_idempotencyKey: { businessId: ctx.businessId, idempotencyKey: payload.idempotencyKey } },
  });

  // §31.2/§33.4 item 6 — a job retried after the send itself already
  // succeeded (e.g. this process died between the adapter call and
  // recording it) must not send a second time; sendMessage() is a real
  // outbound side effect that a retry cannot safely repeat "just in case."
  if (actionRow?.status === "succeeded") {
    return;
  }

  const adapter = getChannelAdapter(payload.channel);
  if (!adapter) {
    const message = `No ChannelAdapter registered for channel "${payload.channel}"`;
    if (actionRow) {
      await db.actionExecution.update({
        where: { id: actionRow.id },
        data: { status: "failed", errorMessage: message, completedAt: new Date() },
      });
    }
    throw new Error(message);
  }

  try {
    const result = await adapter.sendMessage(ctx, payload.connectionId, payload.to, { text: payload.message });
    if (!result.success) {
      throw new Error(result.error ?? "channel adapter reported failure");
    }

    await db.message.create({
      data: { businessId: ctx.businessId, conversationId: payload.conversationId, role: "assistant", content: payload.message },
    });

    if (actionRow) {
      await db.actionExecution.update({
        where: { id: actionRow.id },
        data: {
          status: "succeeded",
          result: { success: true, message: `Follow-up sent: "${payload.message}"`, data: null },
          completedAt: new Date(),
        },
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (actionRow) {
      await db.actionExecution.update({
        where: { id: actionRow.id },
        data: { status: "failed", errorMessage: message, completedAt: new Date() },
      });
    }
    logger.error("[send-followup] failed to send", { businessId: ctx.businessId, conversationId: payload.conversationId, error: message });
    throw error; // lets pg-boss's own retry policy schedule the next attempt
  }
}

jobQueue.registerHandler<SendFollowupPayload>(SEND_FOLLOWUP_JOB, handleSendFollowup);
