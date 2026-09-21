import { z } from "zod";
import type { ToolDefinition } from "../types";

const schema = z.object({
  note: z.string().optional().describe("Free-text note recorded with this test action."),
});

/**
 * PLAN.md §24.3/§34.3 item 6/§46.6 "Explicitly deferred" — no real built-in
 * tool in this plan's scope requires human approval (no refund/payment
 * action exists to migrate). This harmless, side-effect-free tool exists
 * solely so the `pending_approval` mechanism (§23.4/§9.5) is proven and
 * regression-tested end to end, ready the day a real high-stakes tool is
 * added. Its default `ToolPolicy` (`policy.ts`) disables it for AI
 * (`allowedForAI: false`) so no business gains a new AI-callable tool from
 * this phase merely by this file existing — a business (or a test) opts in
 * explicitly via its own `ToolPolicy` row.
 */
export const noopTestActionTool: ToolDefinition = {
  name: "noop_test_action",
  description: "A no-op test action used only to exercise the human-approval workflow. Has no real effect.",
  schema,
  async execute(_ctx, args) {
    const { note } = schema.parse(args);
    return {
      success: true,
      status: "succeeded",
      message: note ? `Test action executed: ${note}` : "Test action executed.",
    };
  },
};
