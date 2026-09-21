import { z } from "zod";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { jobQueue } from "@/lib/jobs/queue";
import { SEND_FOLLOWUP_JOB, type SendFollowupPayload } from "@/lib/jobs/job-types";
import { computeIdempotencyKey } from "../idempotency";
import type { ToolDefinition } from "../types";

const schema = z.object({
  conversationId: z.string().describe("The conversation ID"),
  message: z.string().describe("The follow-up message to send"),
  delayHours: z.number().describe("Hours to wait before sending the follow-up"),
});

/**
 * PLAN.md §24.3/§46.6 PR3 task 14 — the real implementation, now that
 * PR2's `PgBossJobQueue` exists to back it. This is the **first moment**
 * `schedule_followup` is ever exposed to the AI at all (`policy.ts`'s
 * default flips `enabledForTenant` to `true` in this same commit) — and it
 * is durable from that first moment: `jobQueue.schedule()` → on success,
 * `ToolRegistry`'s own `ActionExecution` row (already created by the time
 * this runs, §23.2 step 6) is updated to `scheduled` by the returned
 * status here; if the enqueue call itself throws, this returns a failure
 * and `ToolRegistry` records `failed` — never a status the queue didn't
 * actually back (§24.1/§24.3, review concern 11).
 */
export const scheduleFollowupTool: ToolDefinition = {
  name: "schedule_followup",
  description: "Schedule a follow-up message to the customer after a specified time.",
  schema,
  async execute(ctx, args, runtimeCtx) {
    const { conversationId, message, delayHours } = schema.parse(args);
    const db = getScopedPrisma(ctx);

    const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) {
      return { success: false, status: "failed", message: `Conversation ${conversationId} not found.` };
    }
    if (!conversation.customerContact) {
      return { success: false, status: "failed", message: "This conversation has no customer contact to send a follow-up to." };
    }

    const connection = await db.channelConnection.findFirst({ where: { type: conversation.channel, isActive: true } });
    if (!connection) {
      return {
        success: false,
        status: "failed",
        message: `No active ${conversation.channel} connection is configured to send the follow-up through.`,
      };
    }

    const runAt = new Date(Date.now() + delayHours * 3600_000);
    const idempotencyKey = computeIdempotencyKey(ctx, runtimeCtx);

    try {
      await jobQueue.schedule<SendFollowupPayload>(
        SEND_FOLLOWUP_JOB,
        {
          businessId: ctx.businessId,
          conversationId,
          connectionId: connection.id,
          channel: conversation.channel,
          to: conversation.customerContact,
          message,
          idempotencyKey,
        },
        { runAt, idempotencyKey }
      );
    } catch (error) {
      return {
        success: false,
        status: "failed",
        message: `Failed to schedule follow-up: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }

    return {
      success: true,
      status: "scheduled",
      message: `Follow-up scheduled for ${runAt.toISOString()}`,
      data: { scheduledFor: runAt.toISOString() },
    };
  },
};
