import type { TenantContext } from "@/lib/tenancy/context";
import { findExistingCustomer } from "@/lib/customers/customer-resolver";
import type { ScopedPrisma } from "@/lib/tenancy/scoped-prisma";
type WorkClient = Pick<
  ScopedPrisma,
  "actionExecution" | "deliveryOperation" | "inboundEventReceipt" | "customer" | "conversation"
>;
/** Retire pending work before erasure, using action → operation → receipt lock order.
 * Completed effects retain their status; private payloads and obsolete references do not.
 */
export async function retireConversationWork(
  db: WorkClient,
  conversationIds: string[],
  options: {
    clearReferences?: boolean;
    contacts?: string[];
    identity?: { context: TenantContext; customerId: string };
  } = {}
) {
  const retiredAt = new Date();
  const contacts = options.identity ? [] : [...new Set((options.contacts ?? []).filter(Boolean))];
  const receiptMatches = [
    ...conversationIds.map((id) => ({ eventPayload: { path: ["conversationId"], equals: id } })),
    ...contacts.map((contact) => ({
      eventPayload: { path: ["payload", "customerContact"], equals: contact },
    })),
  ];
  const matchingReceipts = receiptMatches.length
    ? await db.inboundEventReceipt.findMany({ where: { OR: receiptMatches }, select: { id: true } })
    : [];
  const receiptIds = matchingReceipts.map((row) => row.id);
  if (options.identity) {
    // Payload pages and lookup caches are bounded; matched identifiers scale
    // with affected work. Timeout rolls back the entire erasure, never a page.
    let cursor: string | undefined;
    for (;;) {
      const page = await db.inboundEventReceipt.findMany({
        where: {
          retiredAt: null,
          ...(cursor && { id: { gt: cursor } }),
        },
        select: { id: true, eventPayload: true },
        orderBy: { id: "asc" },
        take: 100,
      });
      const lookedUp = new Map<string, string | null>();
      const bound = await db.deliveryOperation.findMany({
        where: {
          receiptId: { in: page.map((row) => row.id) },
          conversationId: { not: null },
        },
        select: { receiptId: true, conversationId: true },
      });
      for (const receipt of page) {
        const event =
          receipt.eventPayload &&
          typeof receipt.eventPayload === "object" &&
          !Array.isArray(receipt.eventPayload)
            ? (receipt.eventPayload as Record<string, unknown>)
            : {};
        const source =
          event.source && typeof event.source === "object"
            ? (event.source as Record<string, unknown>)
            : {};
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as Record<string, unknown>)
            : {};
        if (typeof source.channel !== "string" || typeof payload.customerContact !== "string")
          continue;
        // Established lineage wins over an unbound contact heuristic.
        if (
          bound.some(
            (op) =>
              op.receiptId === receipt.id &&
              op.conversationId &&
              !conversationIds.includes(op.conversationId)
          )
        )
          continue;
        if (
          typeof event.conversationId === "string" &&
          !conversationIds.includes(event.conversationId)
        ) {
          const declared = await db.conversation.findUnique({
            where: { id: event.conversationId },
            select: { customerId: true },
          });
          if (declared && declared.customerId !== options.identity.customerId) continue;
        }
        const key = JSON.stringify([source.channel, payload.customerContact]);
        if (!lookedUp.has(key)) {
          const customer = await findExistingCustomer(
            options.identity.context,
            source.channel,
            payload.customerContact,
            db
          );
          lookedUp.set(key, customer?.id ?? null);
        }
        if (lookedUp.get(key) === options.identity.customerId) receiptIds.push(receipt.id);
      }
      if (page.length < 100) break;
      cursor = page[page.length - 1].id;
    }
  }
  function chunks(values: string[]) {
    const result: string[][] = [];
    for (let offset = 0; offset < values.length; offset += 100)
      result.push(values.slice(offset, offset + 100));
    return result;
  }
  // Completed effects retain status, while all affected rows retire atomically.
  for (const ids of chunks(conversationIds)) {
    await db.actionExecution.updateMany({
      where: { conversationId: { in: ids } },
      data: { input: {}, result: {}, errorMessage: null, retiredAt },
    });
    await db.actionExecution.updateMany({
      where: { conversationId: { in: ids }, status: { notIn: ["succeeded", "cancelled"] } },
      data: { status: "cancelled" },
    });
  }
  const operationIds = new Set<string>();
  const operationMatches = [
    ...chunks(conversationIds).map((ids) => ({ conversationId: { in: ids } })),
    ...chunks([...new Set(receiptIds)]).map((ids) => ({ receiptId: { in: ids } })),
  ];
  for (const where of operationMatches) {
    await db.deliveryOperation.updateMany({
      where,
      data: {
        retiredAt,
        response: "[REDACTED - GDPR]",
        recipient: "",
        metadata: {},
        recoveryLog: [],
        errorMessage: null,
      },
    });
    await db.deliveryOperation.updateMany({
      where: { AND: [where, { status: { not: "accepted" } }] },
      data: { status: "cancelled", claimToken: null, leaseUntil: null },
    });
    const operations = await db.deliveryOperation.findMany({
      where,
      select: { id: true, receiptId: true },
    });
    for (const op of operations) {
      operationIds.add(op.id);
      if (op.receiptId) receiptIds.push(op.receiptId);
    }
  }
  for (const ids of chunks([...new Set(receiptIds)]))
    await db.inboundEventReceipt.updateMany({
      where: { id: { in: ids } },
      data: { processingStatus: "cancelled", eventPayload: {}, retiredAt },
    });
  for (const ids of chunks(conversationIds))
    await db.actionExecution.updateMany({
      where: { conversationId: { in: ids } },
      data: {
        input: {},
        result: {},
        errorMessage: null,
        ...(options.clearReferences && { conversationId: null }),
      },
    });
  return [...operationIds];
}
