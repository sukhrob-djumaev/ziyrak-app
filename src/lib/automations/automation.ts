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

function getFieldValue(
  field: string,
  message: Message,
  conversation: Conversation
): string {
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
  const fieldValue = getFieldValue(
    condition.field,
    message,
    conversation
  ).toLowerCase();
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

  return rule.conditions.every((condition) =>
    evaluateCondition(condition, message, conversation)
  );
}

/**
 * Evaluates all active automation rules against a message and conversation.
 * Returns an array of matched actions sorted by rule priority (highest first).
 *
 * Not yet wired to any real call site (§2.4/§46.6 — full runtime automation
 * reconnection is Phase 6 scope); already converted to explicit-`ctx` now
 * so Phase 6 doesn't inherit an unscoped query here.
 */
export async function evaluateRules(
  ctx: TenantContext,
  message: Message,
  conversation: Conversation
): Promise<MatchedAction[]> {
  const db = getScopedPrisma(ctx);
  const rules = await db.automationRule.findMany({
    where: { isActive: true },
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
        .catch((err) =>
          logger.error(`Failed to increment trigger count for rule ${rule.id}`, err)
        );
    }
  }

  return matchedActions;
}
