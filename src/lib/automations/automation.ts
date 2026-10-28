import { isEntitled } from "@/lib/billing/entitlements";
import { logger } from "@/lib/observability/logger";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

interface Condition {
  field: string;
  operator: string;
  value: string;
}

interface Action {
  type: string;
  value: string;
}

interface AutomationRule {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  conditions: Condition[];
  actions: Action[];
  priority: number;
}

interface Message {
  content: string;
  channel?: string;
  customerName?: string;
}

interface Conversation {
  id: string;
  channel?: string;
  customerName?: string;
}

interface MatchedAction {
  ruleId: string;
  ruleName: string;
  type: string;
  actions: Action[];
}

function getFieldValue(field: string, message: Message, conversation: Conversation): string {
  switch (field) {
    case "message_content":
      return message.content || "";
    case "channel":
      return message.channel || conversation.channel || "";
    case "customer_name":
      return message.customerName || conversation.customerName || "";
    default:
      return "";
  }
}

function evaluateCondition(
  condition: Condition,
  message: Message,
  conversation: Conversation
): boolean {
  const fieldValue = getFieldValue(condition.field, message, conversation).toLowerCase();
  const targetValue = condition.value.toLowerCase();

  switch (condition.operator) {
    case "contains":
      return fieldValue.includes(targetValue);
    case "equals":
      return fieldValue === targetValue;
    case "starts_with":
      return fieldValue.startsWith(targetValue);
    default:
      return false;
  }
}

function ruleMatchesMessage(
  rule: AutomationRule,
  message: Message,
  conversation: Conversation
): boolean {
  if (!rule.conditions || rule.conditions.length === 0) return false;

  return rule.conditions.every((condition) => evaluateCondition(condition, message, conversation));
}

/**
 * Evaluates all active automation rules against a message and conversation.
 * Returns an array of matched actions sorted by rule priority (highest first).
 *
 * PLAN.md §46.6 task 6 — reconnected into `processInboundMessage()`
 * (`conversations/inbound.ts`) as of this phase. `requiresReconfirmation:
 * false` excludes rules that were already `isActive` before this phase's
 * migration backfilled that flag `true` for them (`prisma/migrations/
 * …_phase6_tool_policy_action_execution`) — a business must explicitly
 * re-save such a rule (clearing the flag, `automation-rules/service.ts`)
 * before it gains real runtime effect, so no business is surprised by
 * previously-inert configuration suddenly firing.
 */
export async function evaluateRules(
  ctx: TenantContext,
  message: Message,
  conversation: Conversation
): Promise<MatchedAction[]> {
  // Checked at execution, not only when a rule is saved: a package change takes effect on the next message.
  // The incoming message itself is still stored and answered; only the rules stop firing.
  // Fixed replies (`auto_reply`) keep working so wording the business chose for sensitive questions is never replaced by an
  // AI answer (new behaviour and new spend); routing and tagging stop until the package includes automation again.
  const entitled = await isEntitled(ctx.businessId, "automation.rules");
  const db = getScopedPrisma(ctx);
  const rules = await db.automationRule.findMany({
    where: { isActive: true, requiresReconfirmation: false, ...(entitled ? {} : { type: "auto_reply" }) },
    orderBy: { priority: "desc" },
  });

  const matchedActions: MatchedAction[] = [];

  for (const rule of rules) {
    const conditions = rule.conditions as unknown as Condition[];
    const actions = rule.actions as unknown as Action[];

    const automationRule: AutomationRule = {
      id: rule.id,
      name: rule.name,
      type: rule.type,
      isActive: rule.isActive,
      conditions,
      actions,
      priority: rule.priority,
    };

    if (ruleMatchesMessage(automationRule, message, conversation)) {
      matchedActions.push({
        ruleId: rule.id,
        ruleName: rule.name,
        type: rule.type,
        actions,
      });

      // Increment trigger count in background
      db.automationRule
        .update({
          where: { id: rule.id },
          data: { triggerCount: { increment: 1 } },
        })
        .catch((err) => logger.error(`Failed to increment trigger count for rule ${rule.id}`, err));
    }
  }

  return matchedActions;
}

/**
 * PLAN.md §46.6 task 6 — executes matched rules' actions for real, via
 * direct conversation-mutation calls (as the plan's own task wording
 * allows, alongside the ToolRegistry option) rather than returning them
 * for a caller to discard, which is what made this dead code before this
 * phase (§2.4). Returns the highest-priority matched `auto_reply` action's
 * text, if any — `processInboundMessage`'s caller (`chat()`) uses it to
 * short-circuit AI generation for this turn, an automation-configured
 * reply taking precedence over calling the model at all.
 */
export async function applyAutomationActions(
  ctx: TenantContext,
  conversation: { id: string },
  matchedActions: MatchedAction[]
): Promise<string | undefined> {
  const db = getScopedPrisma(ctx);
  let overrideResponse: string | undefined;

  for (const matched of matchedActions) {
    for (const action of matched.actions) {
      const value = (action.value || "").trim();
      if (!value) continue;

      switch (action.type) {
        case "auto_tag": {
          const tag = await db.tag.upsert({
            where: { businessId_name: { businessId: ctx.businessId, name: value } },
            update: {},
            create: { businessId: ctx.businessId, name: value },
          });
          await db.conversationTag
            .upsert({
              where: { conversationId_tagId: { conversationId: conversation.id, tagId: tag.id } },
              update: {},
              create: {
                businessId: ctx.businessId,
                conversationId: conversation.id,
                tagId: tag.id,
              },
            })
            .catch((err) => logger.error(`[automation] failed to apply auto_tag "${value}"`, err));
          break;
        }
        case "auto_route": {
          const current = await db.conversation.findUnique({ where: { id: conversation.id } });
          const existingMetadata = (current?.metadata as Record<string, unknown> | null) ?? {};
          await db.conversation
            .update({
              where: { id: conversation.id },
              data: { metadata: { ...existingMetadata, routedDepartment: value } },
            })
            .catch((err) =>
              logger.error(`[automation] failed to apply auto_route "${value}"`, err)
            );
          break;
        }
        case "auto_reply": {
          if (!overrideResponse) overrideResponse = value;
          break;
        }
        case "keyword_alert": {
          // Fail closed: this used to e-mail a rule-supplied address through the legacy global SMTP
          // account shared by every workspace, with no tool policy, admission or recorded origin.
          // It sends nothing until a per-workspace e-mail setting exists.
          logger.warn(
            `[automation] keyword_alert skipped for rule "${matched.ruleName}": alert e-mails are disabled until a per-workspace e-mail setting exists`,
            { businessId: ctx.businessId, ruleId: matched.ruleId }
          );
          break;
        }
        default:
          logger.warn(
            `[automation] unrecognized action type "${action.type}" on rule "${matched.ruleName}"`
          );
      }
    }
  }

  return overrideResponse;
}
