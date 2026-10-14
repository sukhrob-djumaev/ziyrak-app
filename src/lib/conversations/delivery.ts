import { randomUUID } from "node:crypto";
import type { Prisma, DeliveryOperation } from "@/generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { getChannelAdapter } from "@/lib/channels/registry";
import { AppError, NotFoundError } from "@/lib/observability/errors";
import { logger } from "@/lib/observability/logger";
import { hasPermission } from "@/lib/rbac/rbac";

const LEASE_MS = 60_000;
export class DeliveryBusyError extends Error {}
export class DeliveryRefusedError extends Error {
  constructor(public retryable: boolean) {
    super("Provider refused the saved delivery.");
  }
}
type NewOperation = {
  operationKey: string;
  kind: "inbound" | "followup";
  receiptId?: string;
  actionId?: string;
  conversationId?: string;
  channel: string;
  connectionId: string;
  recipient: string;
  response?: string;
  metadata?: Record<string, unknown>;
};
export async function ensureDelivery(
  ctx: TenantContext,
  input: NewOperation,
  db: Pick<ReturnType<typeof getScopedPrisma>, "deliveryOperation"> = getScopedPrisma(ctx)
): Promise<DeliveryOperation> {
  return db.deliveryOperation.upsert({
    where: {
      businessId_operationKey: { businessId: ctx.businessId, operationKey: input.operationKey },
    },
    update: {},
    create: {
      ...input,
      businessId: ctx.businessId,
      status: input.response === undefined ? "pending" : "ready",
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
}
function heartbeat(ctx: TenantContext, id: string, claimToken: string) {
  const timer = setInterval(() => {
    void getScopedPrisma(ctx)
      .deliveryOperation.updateMany({
        where: { id, claimToken, status: { in: ["preparing", "sending"] } },
        data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
      })
      .catch(() =>
        logger.warn("Delivery lease renewal unavailable", {
          businessId: ctx.businessId,
          operationId: id,
        })
      );
  }, 10_000);
  timer.unref();
  return () => clearInterval(timer);
}
export async function expireDeliveryClaims(ctx: TenantContext): Promise<void> {
  const db = getScopedPrisma(ctx);
  for (const [from, to, message] of [
    [
      "preparing",
      "preparation_interrupted",
      "Preparation was interrupted; review completed tools and conversation before recovery.",
    ],
    ["sending", "unknown", "The provider outcome is uncertain; automatic resend is blocked."],
  ]) {
    await db.deliveryOperation.updateMany({
      where: { status: from, leaseUntil: { lt: new Date() } },
      data: { status: to, errorMessage: message, retryable: false },
    });
  }
}
export async function prepareDelivery(
  ctx: TenantContext,
  op: DeliveryOperation,
  prepare: (
    recordConversation: (id: string) => Promise<void>
  ) => Promise<{ conversationId: string; response: string }>
): Promise<DeliveryOperation> {
  const db = getScopedPrisma(ctx);
  await expireDeliveryClaims(ctx);
  op = await db.deliveryOperation.findUniqueOrThrow({ where: { id: op.id } });
  if (op.status !== "pending") {
    if (op.status === "preparing")
      throw new DeliveryBusyError("Preparation is still owned by a worker.");
    return op;
  }
  const token = randomUUID();
  const claimed = await db.deliveryOperation.updateMany({
    where: { id: op.id, status: "pending" },
    data: { status: "preparing", claimToken: token, leaseUntil: new Date(Date.now() + LEASE_MS) },
  });
  if (!claimed.count) throw new DeliveryBusyError("Preparation claim was taken by another worker.");
  const end = heartbeat(ctx, op.id, token);
  try {
    const result = await prepare(async (conversationId) => {
      const owned = await db.deliveryOperation.updateMany({
        where: { id: op.id, status: "preparing", claimToken: token },
        data: { conversationId },
      });
      if (!owned.count) throw new DeliveryBusyError("Preparation claim is no longer owned.");
    });
    const saved = await db.deliveryOperation.updateMany({
      where: { id: op.id, status: "preparing", claimToken: token },
      data: {
        conversationId: result.conversationId,
        response: result.response,
        status: "ready",
        leaseUntil: null,
        claimToken: null,
        errorMessage: null,
      },
    });
    if (!saved.count)
      throw new DeliveryBusyError("Preparation claim expired; automatic replay is blocked.");
  } catch (error) {
    await db.deliveryOperation.updateMany({
      where: { id: op.id, status: "preparing", claimToken: token },
      data: {
        status: "preparation_interrupted",
        leaseUntil: null,
        errorMessage:
          "Preparation was interrupted; review completed tools and conversation before recovery.",
        retryable: false,
      },
    });
    throw error;
  } finally {
    end();
  }
  return db.deliveryOperation.findUniqueOrThrow({ where: { id: op.id } });
}
export async function validateDeliveryDestination(
  ctx: TenantContext,
  op: Pick<DeliveryOperation, "conversationId" | "channel" | "connectionId" | "recipient">
): Promise<void> {
  const db = getScopedPrisma(ctx);
  const [conversation, connection] = await Promise.all([
    op.conversationId
      ? db.conversation.findUnique({ where: { id: op.conversationId } })
      : Promise.resolve(null),
    db.channelConnection.findFirst({
      where: { id: op.connectionId, type: op.channel, isActive: true },
    }),
  ]);
  if (
    !conversation ||
    !connection ||
    conversation.channel !== op.channel ||
    conversation.customerContact !== op.recipient
  )
    throw new NotFoundError("Delivery destination");
  const owner = (conversation.metadata as Record<string, unknown> | null)?.channelConnectionId;
  if (owner && owner !== op.connectionId) throw new NotFoundError("Delivery destination");
}
export async function dispatchDelivery(ctx: TenantContext, id: string): Promise<DeliveryOperation> {
  const db = getScopedPrisma(ctx);
  await expireDeliveryClaims(ctx);
  let op = await db.deliveryOperation.findUniqueOrThrow({ where: { id } });
  if (op.status === "sending" || op.status === "preparing")
    throw new DeliveryBusyError("Delivery is still owned by a worker.");
  if (!["ready", "rejected"].includes(op.status) || (op.status === "rejected" && !op.retryable))
    return op;
  if (op.response === null)
    throw new AppError(
      409,
      "NO_SAVED_REPLY",
      "No completed reply exists; review the conversation."
    );
  try {
    await validateDeliveryDestination(ctx, op);
  } catch (error) {
    await db.deliveryOperation.updateMany({
      where: { id, status: op.status },
      data: {
        status: "rejected",
        retryable: false,
        errorMessage:
          "The saved destination is unavailable. Review channel and conversation ownership.",
      },
    });
    throw error;
  }
  const adapter = getChannelAdapter(op.channel);
  if (!adapter) {
    await db.deliveryOperation.updateMany({
      where: { id, status: op.status, updatedAt: op.updatedAt },
      data: {
        status: "rejected",
        retryable: false,
        errorMessage: "The configured channel is unavailable.",
      },
    });
    return db.deliveryOperation.findUniqueOrThrow({ where: { id } });
  }
  const token = randomUUID();
  const claim = await db.deliveryOperation.updateMany({
    where: { id, status: op.status },
    data: {
      status: "sending",
      claimToken: token,
      leaseUntil: new Date(Date.now() + LEASE_MS),
      attempts: { increment: 1 },
      retryable: false,
    },
  });
  if (!claim.count) throw new DeliveryBusyError("Dispatch claim was taken by another worker.");
  const end = heartbeat(ctx, id, token);
  let reportedAcceptance = false;
  let acceptedProviderId: string | undefined;
  try {
    const result = await adapter.sendMessage(ctx, op.connectionId, op.recipient, {
      text: op.response,
      metadata: op.metadata as Record<string, unknown>,
    });
    if (result.success) {
      reportedAcceptance = true;
      acceptedProviderId = result.providerMessageId;
      // Transaction is local only. The prior dispatch claim protects an external
      // acceptance even if this transaction cannot commit.
      await db.$transaction(async (tx) => {
        const accepted = await tx.deliveryOperation.updateMany({
          where: { id, status: "sending", claimToken: token },
          data: {
            status: "accepted",
            providerMessageId: result.providerMessageId ?? null,
            claimToken: null,
            leaseUntil: null,
            errorMessage: null,
          },
        });
        if (!accepted.count)
          throw new DeliveryBusyError("Acceptance checkpoint lost its dispatch claim.");
        if (op.kind === "followup" && op.conversationId) {
          await tx.message.upsert({
            where: { id },
            create: {
              id,
              businessId: ctx.businessId,
              conversationId: op.conversationId,
              role: "assistant",
              content: op.response!,
            },
            update: {},
          });
        }
      });
    } else {
      const known = result.outcome === "rejected";
      await db.deliveryOperation.updateMany({
        where: { id, status: "sending", claimToken: token },
        data: {
          status: known ? "rejected" : "unknown",
          retryable: known && result.retryable === true,
          leaseUntil: null,
          errorMessage: known
            ? "Provider refused the saved delivery."
            : "The provider outcome is uncertain; automatic resend is blocked.",
        },
      });
    }
  } catch {
    await db.deliveryOperation.updateMany({
      where: { id, status: "sending", claimToken: token },
      data: {
        status: "unknown",
        retryable: false,
        leaseUntil: null,
        providerMessageId: acceptedProviderId ?? null,
        errorMessage: reportedAcceptance
          ? "The channel reported acceptance but local persistence failed. Review provider evidence; automatic resend is blocked."
          : "The provider outcome is uncertain; automatic resend is blocked.",
      },
    });
  } finally {
    end();
  }
  op = await db.deliveryOperation.findUniqueOrThrow({ where: { id } });
  return op;
}
/** Synchronize parent statuses while holding the operation's row lock.
 * Recovery uses the same lock order, so a stale worker cannot undo its decision.
 */
export async function projectDeliveryStatus(ctx: TenantContext, id: string): Promise<void> {
  const db = getScopedPrisma(ctx);
  await db.$transaction(async (tx) => {
    const initial = await tx.deliveryOperation.findUniqueOrThrow({ where: { id } });
    // Follow-up creation and erasure also lock action before operation.
    if (initial.actionId)
      await tx.actionExecution.updateMany({
        where: { id: initial.actionId },
        data: { id: initial.actionId },
      });
    const op = await tx.deliveryOperation.findUniqueOrThrow({ where: { id } });
    const locked = await tx.deliveryOperation.updateMany({
      where: { id, status: op.status, updatedAt: op.updatedAt },
      data: { status: op.status },
    });
    if (!locked.count) return; // A recovery already updated its parent rows.
    const success = op.status === "accepted";
    const review = ["unknown", "preparation_interrupted"].includes(op.status);
    const waiting = ["pending", "preparing", "ready", "sending"].includes(op.status);
    if (op.receiptId)
      await tx.inboundEventReceipt.update({
        where: { id: op.receiptId },
        data: {
          processingStatus: success
            ? "processed"
            : op.status === "cancelled"
              ? "cancelled"
              : review
                ? "needs_review"
                : waiting
                  ? "enqueued"
                  : "failed",
        },
      });
    if (op.actionId)
      await tx.actionExecution.update({
        where: { id: op.actionId },
        data: {
          status: success
            ? "succeeded"
            : op.status === "cancelled"
              ? "cancelled"
              : review
                ? "needs_review"
                : waiting
                  ? "scheduled"
                  : "failed",
          errorMessage: op.errorMessage,
          completedAt: waiting ? null : new Date(),
          result: {
            success,
            message: success
              ? "Follow-up accepted by the channel."
              : (op.errorMessage ?? "Follow-up was not accepted."),
            data: { deliveryOperationId: id, providerMessageId: op.providerMessageId },
          },
        },
      });
  });
}
export async function listDeliveryRecovery(ctx: TenantContext) {
  await expireDeliveryClaims(ctx);
  return getScopedPrisma(ctx).deliveryOperation.findMany({
    where: { status: { in: ["unknown", "preparation_interrupted", "rejected", "ready"] } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      kind: true,
      conversationId: true,
      channel: true,
      response: true,
      status: true,
      retryable: true,
      attempts: true,
      errorMessage: true,
      providerMessageId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}
type RecoveryDecision = {
  decision: "confirm_accepted" | "cancel" | "resend";
  reason: string;
  acknowledgeDuplicateRisk?: boolean;
  requestId: string;
};
export async function recoverDelivery(
  ctx: TenantContext,
  id: string,
  input: RecoveryDecision
): Promise<DeliveryOperation> {
  if (ctx.actor.kind !== "user" || !ctx.role || !hasPermission(ctx.role, "actions:approve"))
    throw new AppError(
      403,
      "HUMAN_REQUIRED",
      "A signed-in authorized person must resolve delivery uncertainty."
    );
  const actorId = ctx.actor.userId;
  const db = getScopedPrisma(ctx);
  await expireDeliveryClaims(ctx);
  const op = await db.deliveryOperation.findUnique({ where: { id } });
  if (!op) throw new NotFoundError("Delivery");
  const log = Array.isArray(op.recoveryLog) ? op.recoveryLog : [];
  const prior = log.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>).requestId === input.requestId
  ) as Record<string, unknown> | undefined;
  if (prior) {
    if (
      prior.actorId !== actorId ||
      prior.decision !== input.decision ||
      prior.reason !== input.reason ||
      prior.acknowledgedDuplicateRisk !== (input.acknowledgeDuplicateRisk === true)
    )
      throw new AppError(
        409,
        "REQUEST_KEY_REUSED",
        "Use a new request key for a different decision."
      );
    return op;
  }
  if (!["unknown", "preparation_interrupted", "rejected", "ready"].includes(op.status))
    throw new AppError(409, "ALREADY_HANDLED", "This operation is already being handled.");
  if (input.decision === "confirm_accepted" && op.status !== "unknown")
    throw new AppError(
      409,
      "INVALID_RECOVERY",
      "Only an uncertain dispatch can be confirmed accepted."
    );
  if (input.decision === "resend") {
    if (op.response === null)
      throw new AppError(
        409,
        "NO_SAVED_REPLY",
        "Review the conversation and completed tools; no saved reply exists."
      );
    if (op.status === "unknown" && !input.acknowledgeDuplicateRisk)
      throw new AppError(
        400,
        "DUPLICATION_RISK",
        "Acknowledge that the previous request may have succeeded."
      );
    await validateDeliveryDestination(ctx, op);
  }
  const status =
    input.decision === "resend"
      ? "ready"
      : input.decision === "confirm_accepted"
        ? "accepted"
        : "cancelled";
  const entry = {
    requestId: input.requestId,
    actorId,
    decision: input.decision,
    reason: input.reason,
    previousStatus: op.status,
    at: new Date().toISOString(),
    acknowledgedDuplicateRisk: input.acknowledgeDuplicateRisk === true,
  };
  await db.$transaction(async (tx) => {
    if (op.actionId)
      await tx.actionExecution.updateMany({
        where: { id: op.actionId },
        data: { id: op.actionId },
      });
    const changed = await tx.deliveryOperation.updateMany({
      where: {
        id,
        status: op.status,
        updatedAt: op.updatedAt,
        recoveryLog: { equals: op.recoveryLog as Prisma.InputJsonValue },
      },
      data: {
        status,
        claimToken: null,
        leaseUntil: null,
        retryable: false,
        errorMessage: null,
        recoveryLog: [...log, entry] as Prisma.InputJsonValue,
      },
    });
    if (!changed.count)
      throw new AppError(409, "ALREADY_HANDLED", "Another person already handled this operation.");
    if (
      status === "accepted" &&
      op.kind === "followup" &&
      op.conversationId &&
      op.response !== null
    )
      await tx.message.upsert({
        where: { id },
        create: {
          id,
          businessId: ctx.businessId,
          conversationId: op.conversationId,
          role: "assistant",
          content: op.response,
        },
        update: {},
      });
    await tx.activityLog.create({
      data: {
        businessId: ctx.businessId,
        userId: actorId,
        userName: "Workspace operator",
        action: "delivery.recovered",
        entity: "delivery",
        entityId: id,
        description: "Delivery recovery decision",
        metadata: entry,
      },
    });
    if (op.receiptId && status !== "ready")
      await tx.inboundEventReceipt.update({
        where: { id: op.receiptId },
        data: { processingStatus: status === "accepted" ? "processed" : "cancelled" },
      });
    if (op.actionId && status !== "ready")
      await tx.actionExecution.update({
        where: { id: op.actionId },
        data: {
          status: status === "accepted" ? "succeeded" : "cancelled",
          completedAt: new Date(),
          errorMessage: null,
        },
      });
  });
  return db.deliveryOperation.findUniqueOrThrow({ where: { id } });
}
