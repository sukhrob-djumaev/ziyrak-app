import { z } from "zod";
import { captureFollowupAuthorization } from "../followup-authority";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { jobQueue } from "@/lib/jobs/queue";
import { SEND_FOLLOWUP_JOB, type SendFollowupPayload } from "@/lib/jobs/job-types";
import { computeIdempotencyKey } from "../idempotency";
import type { ToolDefinition } from "../types";
import { AppError, NotFoundError } from "@/lib/observability/errors";

const schema = z.object({
  // The model is never told its conversation's id (the prompt does not contain
  // it and no tool returns it), so it cannot supply one. The runtime
  // conversation is authoritative; this field only exists for callers that
  // have no runtime conversation (e.g. a human or API client) and is ignored
  // whenever one exists, so an AI can never aim a follow-up at another
  // conversation.
  conversationId: z
    .string()
    .optional()
    .describe("Leave empty. The current conversation is used automatically."),
  message: z.string().describe("The follow-up message to send"),
  delayHours: z
    .number()
    .describe(
      "Hours to wait before sending the follow-up. Decimal values are allowed: 1 minute is 0.0167 hours."
    ),
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
  async resolveConversationId(ctx, args, runtimeCtx) {
    const parsed = schema.parse(args);
    const parents = [
      runtimeCtx.conversationId,
      ctx.workBinding?.conversationId,
      ...(ctx.actor.kind === "ai_agent" ? [ctx.actor.conversationId] : []),
    ].filter((value) => value !== undefined);
    if (parents.some((value) => typeof value !== "string" || !value || value.length > 128))
      throw new AppError(400, "INVALID_PARENT", "A valid conversation parent is required");
    if (new Set(parents).size > 1)
      throw new AppError(403, "CONFLICTING_PARENT", "Conversation work parents disagree");
    // Actual server/AI parents win. A model argument is redundant and ignored,
    // preserving the established runtime-bound tool contract.
    const conversationId = parents[0] ?? parsed.conversationId;
    if (!conversationId)
      throw new AppError(400, "INVALID_PARENT", "No conversation to schedule the follow-up in.");
    const conversation = await getScopedPrisma(ctx).conversation.findFirst({
      where: { id: conversationId, retiredAt: null },
      select: { id: true },
    });
    if (!conversation) throw new NotFoundError("Conversation");
    return conversation.id;
  },
  async execute(ctx, args, runtimeCtx, admission) {
    const parsed = schema.parse(args);
    const { message, delayHours } = parsed;
    const conversationId = runtimeCtx.conversationId ?? parsed.conversationId;
    if (!conversationId) {
      return {
        success: false,
        status: "failed",
        message: "No conversation to schedule the follow-up in.",
      };
    }
    const db = getScopedPrisma(ctx);

    const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) {
      return {
        success: false,
        status: "failed",
        message: `Conversation ${conversationId} not found.`,
      };
    }
    if (!conversation.customerContact) {
      return {
        success: false,
        status: "failed",
        message: "This conversation has no customer contact to send a follow-up to.",
      };
    }

    const owner = (conversation.metadata as Record<string, unknown> | null)?.channelConnectionId;
    const connection = await db.channelConnection.findFirst({
      where: {
        type: conversation.channel,
        isActive: true,
        ...(typeof owner === "string" ? { id: owner } : {}),
      },
    });
    if (!connection) {
      return {
        success: false,
        status: "failed",
        message: `No active ${conversation.channel} connection is configured to send the follow-up through.`,
      };
    }

    await captureFollowupAuthorization(
      ctx,
      {
        actionId: ctx.workBinding?.actionExecutionId ?? "",
        conversationId,
        connectionId: connection.id,
      },
      admission
    );

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
