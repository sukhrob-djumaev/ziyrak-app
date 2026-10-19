import { z } from "zod";
import { AppError } from "@/lib/observability/errors";
import { readDeferredProviderConnection } from "@/lib/platform/deferred-origin";
import type { TenantContext } from "./context";
import { getScopedPrisma, type AdmissionSession } from "./scoped-prisma";

const id = z.string().min(1).max(128);
const targetSchema = z.object({ conversationId: id, connectionId: id }).strict();
const originSchema = targetSchema
  .extend({ kind: z.literal("provider_inbound"), receiptId: id, deliveryOperationId: id })
  .strict();
const snapshotSchema = z
  .object({ version: z.literal(1), businessId: id, origin: originSchema })
  .strict();
export type DeferredProviderCeiling = z.infer<typeof snapshotSchema>;
type Target = z.infer<typeof targetSchema>;
const eventSchema = z.object({
  type: z.literal("message.received"),
  businessId: id,
  conversationId: id.optional(),
  correlationId: id,
  source: z.object({ channel: id, connectionId: id, externalId: z.string().min(1).max(4096) }),
  payload: z.object({ customerContact: z.string() }),
});
const receiptStates = new Set(["received", "enqueued", "processed", "failed", "needs_review"]);
const deliveryStates = new Set([
  "preparing",
  "sending",
  "ready",
  "accepted",
  "rejected",
  "unknown",
  "preparation_interrupted",
]);
function deny(): never {
  throw new AppError(
    403,
    "DEFERRED_PROVIDER_UNAVAILABLE",
    "The recorded inbound origin is unavailable"
  );
}
async function validate(
  ctx: TenantContext,
  saved: DeferredProviderCeiling,
  target: Target,
  capture = false,
  session?: AdmissionSession
) {
  if (
    saved.businessId !== ctx.businessId ||
    saved.origin.conversationId !== target.conversationId ||
    saved.origin.connectionId !== target.connectionId
  )
    deny();
  const db = session ? session.repository(ctx) : getScopedPrisma(ctx),
    origin = saved.origin;
  const readReceipt = () => db.inboundEventReceipt.findFirst({ where: { id: origin.receiptId } });
  const readDelivery = () =>
    db.deliveryOperation.findFirst({
      where: { id: origin.deliveryOperationId },
      select: {
        id: true,
        kind: true,
        actionId: true,
        operationKey: true,
        receiptId: true,
        conversationId: true,
        connectionId: true,
        channel: true,
        recipient: true,
        status: true,
        retiredAt: true,
      },
    });
  const readConversation = () =>
    db.conversation.findFirst({
      where: { id: origin.conversationId },
      select: { id: true, channel: true, customerContact: true, metadata: true, retiredAt: true },
    });
  const readConnection = () =>
    readDeferredProviderConnection(ctx.businessId, origin.connectionId, session?.control);
  // One interactive transaction serves a session: read sequentially so no query can outlive
  // the callback; without a session the independent reads stay concurrent.
  let receipt, delivery, conversation, connection;
  if (session) {
    receipt = await readReceipt();
    delivery = await readDelivery();
    conversation = await readConversation();
    connection = await readConnection();
  } else
    [receipt, delivery, conversation, connection] = await Promise.all([
      readReceipt(),
      readDelivery(),
      readConversation(),
      readConnection(),
    ]);
  if (
    !receipt ||
    !delivery ||
    !conversation ||
    !connection ||
    receipt.retiredAt ||
    delivery.retiredAt ||
    conversation.retiredAt
  )
    deny();
  const event = eventSchema.safeParse(receipt.eventPayload);
  if (
    !event.success ||
    !receiptStates.has(receipt.processingStatus) ||
    !deliveryStates.has(delivery.status) ||
    (capture && delivery.status !== "preparing")
  )
    deny();
  const e = event.data;
  if (
    receipt.eventType !== "message.received" ||
    e.businessId !== ctx.businessId ||
    receipt.source !== e.source.channel ||
    receipt.externalEventId !== e.source.externalId ||
    receipt.correlationId !== e.correlationId ||
    e.source.connectionId !== origin.connectionId ||
    (e.conversationId !== undefined && e.conversationId !== origin.conversationId) ||
    delivery.kind !== "inbound" ||
    delivery.actionId !== null ||
    delivery.operationKey !== "receipt:" + receipt.id ||
    delivery.receiptId !== receipt.id ||
    delivery.conversationId !== origin.conversationId ||
    delivery.connectionId !== origin.connectionId ||
    delivery.channel !== e.source.channel ||
    conversation.channel !== e.source.channel ||
    connection.type !== e.source.channel ||
    delivery.recipient !== e.payload.customerContact ||
    conversation.customerContact !== e.payload.customerContact ||
    (conversation.metadata as Record<string, unknown> | null)?.channelConnectionId !==
      origin.connectionId
  )
    deny();
  return saved;
}
/** Capture only from server AI work with explicit durable inbound lineage. A failed human/key
 * origin must never be retried through this branch. This is provenance, not job authorization.
 */
export async function captureDeferredProvider(
  ctx: TenantContext,
  target: Target
): Promise<DeferredProviderCeiling> {
  const parsedTarget = targetSchema.safeParse(target);
  if (
    !parsedTarget.success ||
    ctx.authorization !== undefined ||
    ctx.actor.kind !== "ai_agent" ||
    ctx.role !== null ||
    ctx.actor.conversationId !== parsedTarget.data.conversationId ||
    ctx.workBinding?.conversationId !== parsedTarget.data.conversationId
  )
    deny();
  const saved = snapshotSchema.safeParse({
    version: 1,
    businessId: ctx.businessId,
    origin: {
      kind: "provider_inbound",
      ...parsedTarget.data,
      receiptId: ctx.workBinding.receiptId,
      deliveryOperationId: ctx.workBinding.deliveryOperationId,
    },
  });
  if (!saved.success) deny();
  return validate(ctx, saved.data, parsedTarget.data, true);
}
/** Fresh lineage facts for a system worker; no reusable human grant or TenantContext returned.
 * Accepted/uncertain inbound replies do not erase an already completed tool's valid origin.
 */
export async function refreshDeferredProvider(
  ctx: TenantContext,
  input: unknown,
  target: Target,
  session?: AdmissionSession
): Promise<DeferredProviderCeiling> {
  const saved = snapshotSchema.safeParse(input),
    parsedTarget = targetSchema.safeParse(target);
  if (
    !saved.success ||
    !parsedTarget.success ||
    ctx.actor.kind !== "system_job" ||
    ctx.role !== null ||
    ctx.authorization !== undefined
  )
    deny();
  return validate(ctx, saved.data, parsedTarget.data, false, session);
}
