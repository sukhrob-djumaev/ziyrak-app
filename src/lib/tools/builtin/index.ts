import { toolRegistry } from "../registry";
import { createTicketTool } from "./create-ticket";
import { assignToPersonTool } from "./assign-to-person";
import { sendInternalEmailTool } from "./send-internal-email";
import { getCustomerHistoryTool } from "./get-customer-history";
import { scheduleFollowupTool } from "./schedule-followup";
import { triggerWebhookTool } from "./trigger-webhook";
import { noopTestActionTool } from "./noop-test-action";

/**
 * PLAN.md §23.2 — side-effect-only import: registers every built-in tool
 * against the shared `toolRegistry` singleton. Imported once, at the same
 * kind of module-load boundary `jobs/bootstrap.ts` already uses for job
 * handlers (§46.5) — callers (`ai/engine.ts`, API routes) import this
 * module for its effect rather than each tool needing its own registration
 * call at every call site.
 */
toolRegistry.register(createTicketTool);
toolRegistry.register(assignToPersonTool);
toolRegistry.register(sendInternalEmailTool);
toolRegistry.register(getCustomerHistoryTool);
toolRegistry.register(scheduleFollowupTool);
toolRegistry.register(triggerWebhookTool);
toolRegistry.register(noopTestActionTool);
