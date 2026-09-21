import { z } from "zod";
import type { ToolDefinition } from "../types";

const schema = z.object({
  conversationId: z.string().describe("The conversation ID"),
  message: z.string().describe("The follow-up message to send"),
  delayHours: z.number().describe("Hours to wait before sending the follow-up"),
});

/**
 * PLAN.md §24.3/§46.6 PR1 — registered from PR1 onward so the tool exists
 * end to end (schema, provider-facing JSON conversion, registry lookup),
 * but its `ToolPolicy.enabledForTenant` default is `false` (`policy.ts`)
 * until PR2's real `PgBossJobQueue` exists — `ToolRegistry.execute()`
 * refuses to reach this `execute()` for any actor while that default holds
 * (`isAvailable()` is checked before every call), so this body is
 * unreachable in production until PR3 explicitly enables it. It throws
 * rather than fabricating a "scheduled" result if ever reached anyway
 * (e.g. a bug in the availability check) — never silently claim durability
 * that doesn't exist (§24.1/§24.3, review concern 11).
 *
 * PR3 replaces this body with the real implementation:
 * `jobQueue.schedule("send-followup", {...}, { runAt, idempotencyKey })`.
 */
export const scheduleFollowupTool: ToolDefinition = {
  name: "schedule_followup",
  description: "Schedule a follow-up message to the customer after a specified time.",
  schema,
  async execute() {
    throw new Error(
      "schedule_followup has no durable queue behind it yet (PLAN.md §46.6 PR2/PR3) — this should be unreachable while ToolPolicy.enabledForTenant defaults to false."
    );
  },
};
