import { retirementContext } from "@/lib/tenancy/work-lifecycle";
import { retireConversationWork } from "@/lib/conversations/retire-work";
import { AppError } from "@/lib/observability/errors";
import { effectiveResourceScope } from "@/lib/tenancy/resource-query";
import { hasTenantPermission } from "@/lib/tenancy/resource-scope";
import { logger } from "@/lib/observability/logger";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

/**
 * GDPR Compliance Module
 * Handles data subject requests: export, deletion, anonymization
 */

// PII patterns for detection and redaction
const PII_PATTERNS = [
  {
    name: "credit_card",
    pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    replacement: "[CARD REDACTED]",
  },
  { name: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[SSN REDACTED]" },
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    replacement: "[EMAIL REDACTED]",
  },
  {
    name: "phone",
    pattern: /\b\+?\d{1,3}[\s-]?\(?\d{1,4}\)?[\s-]?\d{1,4}[\s-]?\d{1,9}\b/g,
    replacement: "[PHONE REDACTED]",
  },
  {
    name: "ip_address",
    pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    replacement: "[IP REDACTED]",
  },
];

/**
 * Redact PII from a text string.
 */
export function redactPII(text: string): string {
  let redacted = text;
  for (const { pattern, replacement } of PII_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

/**
 * Detect PII in a text string.
 */
export function detectPII(text: string): { found: boolean; types: string[] } {
  const types: string[] = [];
  for (const { name, pattern } of PII_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      types.push(name);
    }
  }
  return { found: types.length > 0, types };
}

/**
 * Export all data for a customer (GDPR data portability).
 */
export async function exportCustomerData(
  ctx: TenantContext,
  customerId: string
): Promise<Record<string, unknown> | null> {
  const db = getScopedPrisma(ctx);
  const customer = await db.customer.findUnique({
    where: { id: customerId },
    include: {
      notes: true,
      conversations: {
        include: {
          messages: true,
          deliveryOperations: { select: { response: true, status: true, createdAt: true } },
          tickets: {
            select: {
              id: true,
              title: true,
              description: true,
              status: true,
              priority: true,
              createdAt: true,
            },
          },
        },
      },
    },
  });

  if (!customer) return null;

  return {
    exportDate: new Date().toISOString(),
    format: "GDPR Data Export",
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      whatsapp: customer.whatsapp,
      tags: customer.tags,
      firstContact: customer.firstContact,
      lastContact: customer.lastContact,
      createdAt: customer.createdAt,
    },
    notes: customer.notes.map((n) => ({
      content: n.content,
      author: n.authorName,
      date: n.createdAt,
    })),
    conversations: customer.conversations.map((c) => ({
      id: c.id,
      channel: c.channel,
      status: c.status,
      createdAt: c.createdAt,
      messages: c.messages.map((m) => ({
        role: m.role,
        content: m.content,
        date: m.createdAt,
      })),
      tickets: c.tickets,
      deliveryRecovery: c.deliveryOperations,
    })),
  };
}

/**
 * Delete all data for a customer (GDPR right to be forgotten).
 * Anonymizes conversation data instead of hard deleting to preserve analytics.
 */
export async function deleteCustomerData(
  ctx: TenantContext,
  customerId: string,
  hardDelete = false
): Promise<{ success: boolean; deletedRecords: number }> {
  if (effectiveResourceScope(ctx).kind !== "workspace")
    throw new AppError(
      403,
      "FORBIDDEN",
      "Whole-customer erasure requires full workspace authority"
    );
  if (
    ["user", "api_key", "platform_admin"].includes(ctx.actor.kind) &&
    !hasTenantPermission(ctx, "customers:delete")
  )
    throw new AppError(403, "FORBIDDEN", "Customer erasure permission is required");
  return getScopedPrisma(retirementContext(ctx)).$transaction(async (db) => {
    const customer = await db.customer.findUnique({
      where: { id: customerId },
      include: { conversations: { select: { id: true, customerContact: true, metadata: true } } },
    });

    if (!customer) return { success: false, deletedRecords: 0 };

    let deletedRecords = 0;

    // Cancel before transcript erasure so a queued recovery cannot restore cached PII.
    const conversationIds = customer.conversations.map((c) => c.id);
    const actions = await db.actionExecution.findMany({
      where: { conversationId: { in: conversationIds } },
      select: { id: true },
    });
    // Unfinished campaign runs must not keep, or later contact, an erased customer.
    for (const run of await db.campaignRun.findMany({
      select: { id: true, targetCustomerIds: true },
    })) {
      const targets = Array.isArray(run.targetCustomerIds) ? run.targetCustomerIds : [];
      if (targets.includes(customerId))
        await db.campaignRun.updateMany({
          where: { id: run.id },
          data: { targetCustomerIds: targets.filter((id) => id !== customerId) },
        });
    }
    const tickets = await db.ticket.findMany({
      where: { conversationId: { in: conversationIds } },
      select: { id: true },
    });
    const operationIds = await retireConversationWork(db, conversationIds, {
      clearReferences: hardDelete,
      identity: { context: ctx, customerId },
      contacts: [
        customer.phone,
        customer.email,
        customer.whatsapp,
        (customer.metadata as Record<string, unknown> | null)?.webchatVisitorId,
        ...customer.conversations.map((c) => c.customerContact),
      ].filter((value): value is string => typeof value === "string" && Boolean(value)),
    });
    const audits = await db.activityLog.findMany({
      where: {
        OR: [
          { entity: "customer", entityId: customerId },
          { entity: "conversation", entityId: { in: conversationIds } },
          { entity: "action", entityId: { in: actions.map((row) => row.id) } },
          { entity: "ticket", entityId: { in: tickets.map((row) => row.id) } },
          { entity: "delivery", entityId: { in: operationIds } },
        ],
      },
    });
    // Retain accountability fields; discard cached content/reasons/results.
    const auditFields = new Set([
      "requestId",
      "actorId",
      "decision",
      "previousStatus",
      "at",
      "acknowledgedDuplicateRisk",
    ]);
    for (const audit of audits) {
      const source =
        audit.metadata && typeof audit.metadata === "object" && !Array.isArray(audit.metadata)
          ? audit.metadata
          : {};
      const metadata = Object.fromEntries(
        Object.entries(source).filter(
          ([key, value]) =>
            auditFields.has(key) && ["string", "boolean", "number"].includes(typeof value)
        )
      );
      if (audit.action === "delivery.recovered") metadata.reason = "[REDACTED - GDPR]";
      await db.activityLog.update({
        where: { id: audit.id },
        data: { description: "[REDACTED - GDPR]", metadata },
      });
    }

    // Nullable call references survive conversation deletion; remove their PII first.
    await db.callLog.updateMany({
      where: { conversationId: { in: conversationIds } },
      data: { from: "", to: "", recording: null, summary: "" },
    });
    if (hardDelete) {
      // Full deletion - cascading
      for (const conv of customer.conversations) {
        await db.message.deleteMany({ where: { conversationId: conv.id } });
        await db.internalNote.deleteMany({ where: { conversationId: conv.id } });
        await db.conversationTag.deleteMany({ where: { conversationId: conv.id } });
        await db.ticket.deleteMany({ where: { conversationId: conv.id } });
        deletedRecords += 5;
      }
      await db.conversation.deleteMany({ where: { customerId } });
      await db.customerNote.deleteMany({ where: { customerId } });
      await db.customer.delete({ where: { id: customerId } });
      deletedRecords += customer.conversations.length + 2;
    } else {
      // Anonymization - preserve structure but remove PII
      for (const conv of customer.conversations) {
        await db.message.updateMany({
          where: { conversationId: conv.id },
          data: { content: "[REDACTED - GDPR]", mediaUrl: null, mediaType: null, toolCalls: {} },
        });
        await db.internalNote.deleteMany({ where: { conversationId: conv.id } });
        await db.ticket.updateMany({
          where: { conversationId: conv.id },
          data: { title: "[REDACTED - GDPR]", description: "[REDACTED - GDPR]", resolution: "" },
        });
        const connectionId = (conv.metadata as Record<string, unknown> | null)?.channelConnectionId;
        await db.conversation.update({
          where: { id: conv.id },
          data: {
            summary: "",
            metadata: typeof connectionId === "string" ? { channelConnectionId: connectionId } : {},
          },
        });
        deletedRecords++;
      }

      await db.conversation.updateMany({
        where: { customerId },
        data: {
          retiredAt: new Date(),
          customerName: "Deleted User",
          customerContact: "",
          customerId: null,
        },
      });

      await db.customerNote.deleteMany({ where: { customerId } });
      await db.customer.delete({ where: { id: customerId } });
      deletedRecords += 2;
    }

    logger.info("GDPR data deletion completed", {
      businessId: ctx.businessId,
      customerId,
      hardDelete,
      deletedRecords,
    });

    return { success: true, deletedRecords };
  });
}

/**
 * Apply data retention policy - delete data older than specified days.
 */
export async function applyRetentionPolicy(
  ctx: TenantContext,
  retentionDays: number
): Promise<{ conversationsDeleted: number; messagesDeleted: number }> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const total = { conversationsDeleted: 0, messagesDeleted: 0 };
  for (;;) {
    const batch = await getScopedPrisma(retirementContext(ctx)).$transaction(async (db) => {
      const oldConversations = await db.conversation.findMany({
        where: { status: { in: ["resolved", "closed"] }, updatedAt: { lte: cutoff } },
        select: { id: true },
        orderBy: { id: "asc" },
        take: 200,
      });
      const ids = oldConversations.map((c) => c.id);
      if (!ids.length) return { conversationsDeleted: 0, messagesDeleted: 0 };
      await retireConversationWork(db, ids, { clearReferences: true });
      const messages = await db.message.deleteMany({ where: { conversationId: { in: ids } } });
      const conversations = await db.conversation.deleteMany({ where: { id: { in: ids } } });
      return { conversationsDeleted: conversations.count, messagesDeleted: messages.count };
    });
    total.conversationsDeleted += batch.conversationsDeleted;
    total.messagesDeleted += batch.messagesDeleted;
    if (batch.conversationsDeleted < 200) break;
  }
  logger.info("Retention policy applied", { businessId: ctx.businessId, retentionDays, ...total });
  return total;
}
