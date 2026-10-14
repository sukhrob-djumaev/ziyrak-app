import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma, type ScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { resolveCustomer } from "@/lib/customers/customer-resolver";
import { chat } from "@/lib/ai/engine";
import { evaluateRules, applyAutomationActions } from "@/lib/automations/automation";
import { createNewConversation } from "@/lib/conversations/conversation-service";
import type { ZiyrakEvent, MessageReceivedPayload } from "@/lib/events/types";
import { loadReceiptEvent, markReceiptProcessed } from "@/lib/events/inbound-receipt";
import {
  jobQueue,
  PROCESS_INBOUND_MESSAGE_JOB,
  type ProcessInboundMessagePayload,
} from "@/lib/jobs/queue";
import {
  ensureDelivery,
  prepareDelivery,
  dispatchDelivery,
  DeliveryBusyError,
  DeliveryRefusedError,
  projectDeliveryStatus,
} from "./delivery";
import { WorkRetiredError } from "@/lib/tenancy/work-lifecycle";
import { NotFoundError } from "@/lib/observability/errors";
import { logger } from "@/lib/observability/logger";
import { logActivity } from "@/lib/observability/activity";
import { emitNewConversation } from "@/lib/realtime/realtime";

export interface OutboundResult {
  conversationId: string;
  response: string;
  deliveryStatus?: string;
}

/**
 * PLAN.md §18.2/§46.5 — replaces the near-identical "resolve customer, then
 * find-or-create an open Conversation for that channel/contact" block that
 * used to be duplicated across all five channel files. Two cases are
 * preserved exactly rather than unified further, because they were already
 * genuinely different behaviors before this phase and nothing in §46.5
 * asks to change either:
 *
 *  - `event.conversationId` set, channel `"webchat"` — the widget generates
 *    its own conversation id client-side (§20.4) so it knows what to
 *    subscribe to for the reply before the async job that creates the row
 *    has even run; if that id doesn't exist yet, it's created with that
 *    exact id (Prisma accepts an explicit `id` on `create`), otherwise the
 *    existing one is reused (every later message in the same widget
 *    session).
 *  - Authenticated internal chat continuation resolves the id through the
 *    tenant repository; it does not pretend its synthetic source owns a real
 *    channel. Explicit real-channel ids must match channel, connection/contact.
 *    Unknown/foreign ids fail before AI preparation.
 *  - no `conversationId` and no usable `customerContact` (the internal chat
 *    API's anonymous default) → always creates a new conversation, exactly
 *    matching `/api/chat`'s pre-Phase-5 behavior (it never searched for an
 *    existing conversation by contact at all).
 *
 * Every other real channel always has a non-empty `customerContact` and no
 * `conversationId`, so it always takes the fourth branch — identical to
 * each channel's own pre-Phase-5 `db.conversation.findFirst(...)` block.
 *
 * Exported (not just used internally by `processInboundMessage` below) so
 * that Phone's call-start leg (`channels/phone-adapter.ts`'s
 * `handleIncomingCall`) can reuse it too: that leg genuinely cannot go
 * through `processInboundMessage` itself (there is no customer message yet
 * to hand `chat()` — the greeting is static configuration, not an AI
 * turn), but "resolve customer → find/create conversation" is exactly the
 * same operation there as everywhere else, and hand-rolling a second copy
 * of it would be precisely the duplicated orchestration §46.5's acceptance
 * criteria forbid outside this one path.
 */
/**
 * A Web Chat widget supplies its own conversation id; this id already belongs to
 * another business. Permanent (retrying cannot help) and deliberately free of any
 * detail about whose it is.
 */
export class ConversationIdUnavailableError extends NotFoundError {
  constructor() {
    super("Conversation");
    this.name = "ConversationIdUnavailableError";
  }
}

export async function resolveOrCreateConversation(
  ctx: TenantContext,
  event: ZiyrakEvent<MessageReceivedPayload>,
  repository?: Pick<ScopedPrisma, "customer" | "conversation" | "activityLog">,
  afterCommit?: (() => void)[]
) {
  const db = repository ?? getScopedPrisma(ctx);

  if (event.conversationId && event.source.channel === "webchat") {
    const existing = await db.conversation.findUnique({ where: { id: event.conversationId } });
    if (existing?.retiredAt) throw new WorkRetiredError();
    if (existing) {
      // PLAN.md §46.7 — `WebChatAdapter.validateInbound` already refuses this
      // case before a receipt is ever written; this is the second,
      // independent check (a job replayed from an older receipt, or a future
      // caller that skips the adapter) so a client-supplied conversation id
      // can never route a message into another connection's/visitor's thread.
      const owningConnectionId = (existing.metadata as Record<string, unknown> | null)
        ?.channelConnectionId;
      if (
        owningConnectionId !== event.source.connectionId ||
        existing.customerContact !== event.payload.customerContact
      ) {
        throw new Error("Web Chat conversation does not belong to this connection/visitor");
      }
      return existing;
    }

    // PLAN.md §20.4/§46.5 acceptance-audit correction: §20.4 states
    // "WebChatAdapter otherwise behaves like any other ChannelAdapter" —
    // customer resolution is not a named exception, so it must not be
    // skipped here just because the conversation id itself is
    // client-supplied. `customerContact` is the widget's own persistent
    // *visitor* id (distinct from this conversation's id — a visitor may
    // start several conversations over time), so resolveCustomer() can
    // correlate repeat visits to one Customer exactly like every other
    // channel, via customer-resolver.ts's webchat case (metadata-based
    // match, since Customer has no dedicated webchat column).
    const customerId = event.payload.customerContact
      ? await resolveCustomer(
          ctx,
          event.source.channel,
          event.payload.customerContact,
          event.payload.customerName,
          db
        )
      : undefined;

    // `metadata.channelConnectionId` is what the public stream route
    // (`/api/channels/webchat/[connectionId]/stream`) checks so one
    // widget/connection cannot subscribe to another connection's
    // conversation even within the same business (§20.4's own isolation
    // requirement, tighter than plain businessId scoping).
    // This business has no such conversation (the lookup above is tenant-scoped), so a
    // primary-key collision here means the id belongs to another business.
    const created = await db.conversation
      .create({
        data: {
          id: event.conversationId,
          businessId: ctx.businessId,
          channel: event.source.channel,
          customerName: event.payload.customerName,
          customerContact: event.payload.customerContact,
          ...(customerId && { customerId }),
          metadata: { channelConnectionId: event.source.connectionId },
        },
      })
      .catch((error: unknown) => {
        if ((error as { code?: string } | null)?.code === "P2002")
          throw new ConversationIdUnavailableError();
        throw error;
      });
    await logActivity(
      ctx,
      "conversation.created",
      "conversation",
      created.id,
      `New webchat conversation started by ${event.payload.customerName}`,
      undefined,
      { channel: "webchat" },
      db
    );
    const announce = () => emitNewConversation(ctx.businessId, created.id, { channel: "webchat" });
    if (afterCommit) afterCommit.push(announce);
    else announce();
    return created;
  }

  if (event.conversationId) {
    const existing = await db.conversation.findUnique({ where: { id: event.conversationId } });
    if (existing?.retiredAt) throw new WorkRetiredError();
    // Authenticated internal chat returns its response directly. Its synthetic
    // connection is not the external connection that owns an existing thread.
    if (
      event.source.channel === "api" &&
      event.source.connectionId === "internal-chat-api" &&
      (ctx.actor.kind === "user" || ctx.actor.kind === "api_key")
    ) {
      if (!existing) throw new ConversationIdUnavailableError();
      return existing;
    }
    const connectionId = (existing?.metadata as Record<string, unknown> | null)
      ?.channelConnectionId;
    if (
      !existing ||
      existing.channel !== event.source.channel ||
      connectionId !== event.source.connectionId ||
      existing.customerContact !== event.payload.customerContact
    ) {
      throw new ConversationIdUnavailableError();
    }
    return existing;
  }

  const { channel } = event.source;
  const { customerContact, customerName } = event.payload;

  if (!customerContact) {
    return createNewConversation(
      ctx,
      channel,
      customerName,
      customerContact,
      undefined,
      undefined,
      event.source.connectionId,
      db,
      afterCommit
    );
  }

  const customerId = await resolveCustomer(ctx, channel, customerContact, customerName, db);

  const existing = await db.conversation.findFirst({
    where: {
      channel,
      // Two same-type connections are independent resources. Legacy unstamped
      // threads are not inferred to belong to whichever connection arrived next.
      metadata: { path: ["channelConnectionId"], equals: event.source.connectionId },
      status: { in: ["active", "escalated"] },
      retiredAt: null,
      OR: [{ customerId }, { customerContact }],
    },
  });

  return (
    existing ??
    (await createNewConversation(
      ctx,
      channel,
      customerName,
      customerContact,
      customerId,
      undefined,
      event.source.connectionId,
      db,
      afterCommit
    ))
  );
}

/**
 * PLAN.md §18.2 — the single inbound entry point every channel funnels
 * through, whether invoked directly (the internal chat API, awaited in the
 * same request/response cycle, §17.6) or from a job handler (every real
 * provider channel, after its webhook route has already ACKed — §17.6).
 * `ctx` is explicit throughout (§8.2/§16.1); this function never resolves
 * its own tenant.
 *
 * The final step (§5.3's diagram: "ChannelAdapter.sendMessage(ctx, to,
 * response) — reply back out via the same channel") lives here too, not in
 * a separate step the caller must remember to do — a `ChannelAdapter` is
 * looked up by `event.source.channel` and only invoked if one is
 * registered, so the internal chat API's synthetic `"api"` channel (no
 * registered adapter, no real destination to send to — its caller already
 * gets the response in the HTTP response body) is silently skipped rather
 * than treated as an error.
 */
export async function processInboundMessage(
  ctx: TenantContext,
  event: ZiyrakEvent<MessageReceivedPayload>,
  runtime?: { receiptId: string }
): Promise<OutboundResult> {
  if (event.businessId !== ctx.businessId) throw new NotFoundError("Inbound event");
  let workCtx = ctx;
  const prepare = async (
    recordConversation?: (
      id: string,
      repository?: Pick<ScopedPrisma, "deliveryOperation">
    ) => Promise<void>
  ) => {
    const afterCommit: (() => void)[] = [];
    const conversation = await getScopedPrisma(workCtx).$transaction(async (tx) => {
      const resolved = await resolveOrCreateConversation(workCtx, event, tx, afterCommit);
      if (recordConversation) await recordConversation(resolved.id, tx);
      return resolved;
    });
    const preparationCtx: TenantContext = {
      ...workCtx,
      workBinding: { ...workCtx.workBinding, conversationId: conversation.id },
    };
    for (const announce of afterCommit) announce();
    const matchedActions = await evaluateRules(
      preparationCtx,
      {
        content: event.payload.text,
        channel: event.source.channel,
        customerName: event.payload.customerName,
      },
      {
        id: conversation.id,
        channel: event.source.channel,
        customerName: event.payload.customerName,
      }
    );
    const overrideResponse = await applyAutomationActions(
      preparationCtx,
      conversation,
      matchedActions
    );
    const response = await chat(
      preparationCtx,
      conversation.id,
      event.payload.text,
      overrideResponse ? { overrideResponse } : undefined
    );
    return { conversationId: conversation.id, response };
  };
  // The internal API receives the completed response directly and has no external send.
  if (event.source.channel === "api") return prepare();
  const op = await ensureDelivery(ctx, {
    operationKey: runtime ? "receipt:" + runtime.receiptId : "event:" + event.id,
    kind: "inbound",
    receiptId: runtime?.receiptId,
    channel: event.source.channel,
    connectionId: event.source.connectionId,
    recipient: event.payload.customerContact,
    metadata: event.metadata,
  });
  workCtx = {
    ...ctx,
    workBinding: {
      ...ctx.workBinding,
      deliveryOperationId: op.id,
      ...(runtime && { receiptId: runtime.receiptId }),
    },
  };
  const prepared = await prepareDelivery(workCtx, op, prepare);
  const result = await dispatchDelivery(ctx, prepared.id);
  if (result.status === "rejected" && result.retryable) throw new DeliveryRefusedError(true);
  return {
    conversationId: result.conversationId ?? event.conversationId ?? "",
    response: result.response ?? "",
    deliveryStatus: result.status,
  };
}

export async function handleProcessInboundMessage(
  ctx: TenantContext,
  payload: ProcessInboundMessagePayload
): Promise<void> {
  if (payload.businessId !== ctx.businessId) throw new NotFoundError("Inbound event");
  const db = getScopedPrisma(ctx);
  const receipt = await db.inboundEventReceipt.findUnique({ where: { id: payload.receiptId } });
  if (receipt?.processingStatus === "processed" || receipt?.processingStatus === "cancelled")
    return;
  const event = await loadReceiptEvent(ctx, payload.receiptId);
  try {
    const result = await processInboundMessage(ctx, event as ZiyrakEvent<MessageReceivedPayload>, {
      receiptId: payload.receiptId,
    });
    const op = await db.deliveryOperation.findUnique({
      where: {
        businessId_operationKey: {
          businessId: ctx.businessId,
          operationKey: "receipt:" + payload.receiptId,
        },
      },
    });
    if (op) await projectDeliveryStatus(ctx, op.id);
    else
      await markReceiptProcessed(
        ctx,
        payload.receiptId,
        result.deliveryStatus ? "failed" : "processed"
      );
  } catch (error) {
    if (error instanceof ConversationIdUnavailableError) {
      const op = await db.deliveryOperation.findUnique({
        where: {
          businessId_operationKey: {
            businessId: ctx.businessId,
            operationKey: "receipt:" + payload.receiptId,
          },
        },
      });
      if (op)
        await db.deliveryOperation.updateMany({
          where: { id: op.id, status: "preparation_interrupted", updatedAt: op.updatedAt },
          data: {
            status: "rejected",
            retryable: false,
            claimToken: null,
            leaseUntil: null,
            errorMessage: "The supplied conversation is unavailable.",
          },
        });
      if (op) await projectDeliveryStatus(ctx, op.id);
      else await markReceiptProcessed(ctx, payload.receiptId, "failed");
      logger.warn("Inbound conversation id unavailable", {
        businessId: ctx.businessId,
        receiptId: payload.receiptId,
      });
      return;
    }
    const op = await db.deliveryOperation.findUnique({
      where: {
        businessId_operationKey: {
          businessId: ctx.businessId,
          operationKey: "receipt:" + payload.receiptId,
        },
      },
    });
    if (op) await projectDeliveryStatus(ctx, op.id);
    else
      await markReceiptProcessed(
        ctx,
        payload.receiptId,
        error instanceof DeliveryBusyError ? "enqueued" : "failed"
      );
    throw error;
  }
}
jobQueue.registerHandler<ProcessInboundMessagePayload>(
  PROCESS_INBOUND_MESSAGE_JOB,
  handleProcessInboundMessage
);
