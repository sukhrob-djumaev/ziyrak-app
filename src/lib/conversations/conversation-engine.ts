import { logger } from "@/lib/observability/logger";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

/**
 * Conversation Routing & Management Engine
 *
 * PLAN.md §16.2 — every function takes `ctx: TenantContext` explicit and
 * resolves its own `getScopedPrisma(ctx)`.
 */

// Routing strategies
export type RoutingStrategy = "round_robin" | "least_busy" | "skill_based" | "priority";

interface RoutingResult {
  assignedToId: string;
  assignedToName: string;
  departmentId: string;
  departmentName: string;
  reason: string;
}

/**
 * Route a conversation to the best available agent.
 */
export async function routeConversation(
  ctx: TenantContext,
  strategy: RoutingStrategy = "skill_based",
  requiredExpertise?: string,
  departmentId?: string
): Promise<RoutingResult | null> {
  const db = getScopedPrisma(ctx);
  const where: Record<string, unknown> = { isAvailable: true };
  if (departmentId) where.departmentId = departmentId;

  const members = await db.teamMember.findMany({
    where,
    include: {
      department: true,
      _count: { select: { tickets: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  if (members.length === 0) return null;

  let selected;

  switch (strategy) {
    case "skill_based":
      if (requiredExpertise) {
        const expertiseLower = requiredExpertise.toLowerCase();
        selected = members.find((m) =>
          m.expertise.toLowerCase().includes(expertiseLower)
        );
      }
      if (!selected) selected = members[0];
      break;

    case "least_busy":
      selected = members.reduce((min, m) =>
        m._count.tickets < min._count.tickets ? m : min
      );
      break;

    case "round_robin": {
      // Get the last assigned member and pick the next one
      const lastTicket = await db.ticket.findFirst({
        where: { assignedToId: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { assignedToId: true },
      });
      if (lastTicket?.assignedToId) {
        const lastIndex = members.findIndex((m) => m.id === lastTicket.assignedToId);
        selected = members[(lastIndex + 1) % members.length];
      } else {
        selected = members[0];
      }
      break;
    }

    case "priority":
    default:
      selected = members[0];
      break;
  }

  if (!selected) return null;

  return {
    assignedToId: selected.id,
    assignedToName: selected.name,
    departmentId: selected.departmentId,
    departmentName: selected.department.name,
    reason: `Routed via ${strategy} strategy`,
  };
}

/**
 * Transfer a conversation to another agent.
 */
export async function transferConversation(
  ctx: TenantContext,
  conversationId: string,
  toMemberId: string,
  fromMemberName: string,
  note?: string
): Promise<boolean> {
  const db = getScopedPrisma(ctx);
  const member = await db.teamMember.findUnique({
    where: { id: toMemberId },
    select: { id: true, name: true },
  });

  if (!member) return false;

  // Update all open tickets for this conversation
  await db.ticket.updateMany({
    where: { conversationId, status: { in: ["open", "in_progress"] } },
    data: { assignedToId: toMemberId },
  });

  // Add internal note about transfer
  await db.internalNote.create({
    data: {
      businessId: ctx.businessId,
      conversationId,
      content: `Conversation transferred from ${fromMemberName} to ${member.name}${note ? `: ${note}` : ""}`,
      authorName: "System",
    },
  });

  logger.info("Conversation transferred", {
    businessId: ctx.businessId,
    conversationId,
    from: fromMemberName,
    to: member.name,
  });

  return true;
}

/**
 * Merge two conversations into one.
 */
export async function mergeConversations(
  ctx: TenantContext,
  primaryId: string,
  secondaryId: string
): Promise<boolean> {
  const db = getScopedPrisma(ctx);
  const [primary, secondary] = await Promise.all([
    db.conversation.findUnique({ where: { id: primaryId } }),
    db.conversation.findUnique({ where: { id: secondaryId } }),
  ]);

  if (!primary || !secondary) return false;

  // Move all messages from secondary to primary
  await db.message.updateMany({
    where: { conversationId: secondaryId },
    data: { conversationId: primaryId },
  });

  // Move tickets
  await db.ticket.updateMany({
    where: { conversationId: secondaryId },
    data: { conversationId: primaryId },
  });

  // Move internal notes
  await db.internalNote.updateMany({
    where: { conversationId: secondaryId },
    data: { conversationId: primaryId },
  });

  // Add merge note
  await db.internalNote.create({
    data: {
      businessId: ctx.businessId,
      conversationId: primaryId,
      content: `Merged with conversation ${secondaryId} (${secondary.customerName} via ${secondary.channel})`,
      authorName: "System",
    },
  });

  // Close secondary
  await db.conversation.update({
    where: { id: secondaryId },
    data: { status: "closed", summary: `Merged into ${primaryId}` },
  });

  return true;
}

/**
 * Snooze a conversation - mark it for follow-up at a later time.
 */
export async function snoozeConversation(
  ctx: TenantContext,
  conversationId: string,
  snoozeUntil: Date,
  reason: string,
  authorName: string
): Promise<boolean> {
  const db = getScopedPrisma(ctx);
  await db.conversation.update({
    where: { id: conversationId },
    data: {
      status: "snoozed",
      metadata: {
        snoozeUntil: snoozeUntil.toISOString(),
        snoozeReason: reason,
      },
    },
  });

  await db.internalNote.create({
    data: {
      businessId: ctx.businessId,
      conversationId,
      content: `Snoozed until ${snoozeUntil.toLocaleDateString()}: ${reason}`,
      authorName,
    },
  });

  return true;
}

/**
 * Auto-escalate conversations that breach SLA.
 */
export async function checkSLABreaches(ctx: TenantContext): Promise<number> {
  const db = getScopedPrisma(ctx);
  const slaRules = await db.sLARule.findMany({
    where: { isActive: true },
  });

  if (slaRules.length === 0) return 0;

  let escalated = 0;

  for (const rule of slaRules) {
    const cutoff = new Date(Date.now() - rule.firstResponseMins * 60 * 1000);

    const breached = await db.conversation.findMany({
      where: {
        status: "active",
        createdAt: { lte: cutoff },
        ...(rule.channel !== "all" ? { channel: rule.channel } : {}),
        messages: { none: { role: "assistant" } },
      },
      take: 50,
    });

    for (const conv of breached) {
      await db.conversation.update({
        where: { id: conv.id },
        data: { status: "escalated" },
      });
      escalated++;
    }
  }

  if (escalated > 0) {
    logger.warn(`SLA breach: ${escalated} conversations auto-escalated`, { businessId: ctx.businessId });
  }

  return escalated;
}

/**
 * Execute a macro (multiple actions at once).
 */
export async function executeMacro(
  ctx: TenantContext,
  conversationId: string,
  actions: { type: string; value: string }[],
  authorName: string
): Promise<{ executed: number; errors: string[] }> {
  const db = getScopedPrisma(ctx);
  let executed = 0;
  const errors: string[] = [];
  const businessId = ctx.businessId;

  for (const action of actions) {
    try {
      switch (action.type) {
        case "set_status":
          await db.conversation.update({
            where: { id: conversationId },
            data: { status: action.value },
          });
          executed++;
          break;

        case "assign_department": {
          const dept = await db.department.findFirst({
            where: { name: { contains: action.value, mode: "insensitive" } },
          });
          if (dept) {
            await db.ticket.updateMany({
              where: { conversationId },
              data: { departmentId: dept.id },
            });
            executed++;
          }
          break;
        }

        case "add_tag": {
          let tag = await db.tag.findUnique({
            where: { businessId_name: { businessId, name: action.value } },
          });
          if (!tag) {
            tag = await db.tag.create({ data: { businessId, name: action.value } });
          }
          await db.conversationTag.create({
            data: { businessId, conversationId, tagId: tag.id },
          }).catch(() => { /* already tagged */ });
          executed++;
          break;
        }

        case "add_note":
          await db.internalNote.create({
            data: { businessId, conversationId, content: action.value, authorName },
          });
          executed++;
          break;

        case "send_message":
          await db.message.create({
            data: { businessId, conversationId, role: "assistant", content: action.value },
          });
          executed++;
          break;

        default:
          errors.push(`Unknown action type: ${action.type}`);
      }
    } catch (err) {
      errors.push(`${action.type}: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  return { executed, errors };
}
