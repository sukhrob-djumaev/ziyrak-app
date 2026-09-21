import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { resolveCustomer } from "@/lib/customers/customer-resolver";
import { chat } from "@/lib/ai/engine";
import { evaluateRules, applyAutomationActions } from "@/lib/automations/automation";
import { createNewConversation } from "@/lib/conversations/conversation-service";
import type { ZiyrakEvent, MessageReceivedPayload } from "@/lib/events/types";
import { loadReceiptEvent, markReceiptProcessed } from "@/lib/events/inbound-receipt";
import { jobQueue, PROCESS_INBOUND_MESSAGE_JOB, type ProcessInboundMessagePayload } from "@/lib/jobs/queue";
import { getChannelAdapter } from "@/lib/channels/registry";
import { logger } from "@/lib/observability/logger";
import { logActivity } from "@/lib/observability/activity";

export interface OutboundResult {
  conversationId: string;
  response: string;
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
 *  - `event.conversationId` set, any other channel (the internal chat
 *    API's "continue this conversation" case) → used as-is, unresolved
 *    here; `chat()` itself already returns "Conversation not found." for a
 *    bad id, so this stays a pure passthrough exactly like `/api/chat`
 *    today.
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
export async function resolveOrCreateConversation(ctx: TenantContext, event: ZiyrakEvent<MessageReceivedPayload>) {
  const db = getScopedPrisma(ctx);

  if (event.conversationId && event.source.channel === "webchat") {
    const existing = await db.conversation.findUnique({ where: { id: event.conversationId } });
    if (existing) {
      // PLAN.md §46.7 — `WebChatAdapter.validateInbound` already refuses this
      // case before a receipt is ever written; this is the second,
      // independent check (a job replayed from an older receipt, or a future
      // caller that skips the adapter) so a client-supplied conversation id
      // can never route a message into another connection's/visitor's thread.
      const owningConnectionId = (existing.metadata as Record<string, unknown> | null)?.channelConnectionId;
      if (owningConnectionId !== event.source.connectionId || existing.customerContact !== event.payload.customerContact) {
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
      ? await resolveCustomer(ctx, event.source.channel, event.payload.customerContact, event.payload.customerName)
      : undefined;

    // `metadata.channelConnectionId` is what the public stream route
    // (`/api/channels/webchat/[connectionId]/stream`) checks so one
    // widget/connection cannot subscribe to another connection's
    // conversation even within the same business (§20.4's own isolation
    // requirement, tighter than plain businessId scoping).
    const created = await db.conversation.create({
      data: {
        id: event.conversationId,
        businessId: ctx.businessId,
        channel: event.source.channel,
        customerName: event.payload.customerName,
        customerContact: event.payload.customerContact,
        ...(customerId && { customerId }),
        metadata: { channelConnectionId: event.source.connectionId },
      },
    });
    await logActivity(ctx, "conversation.created", "conversation", created.id, `New webchat conversation started by ${event.payload.customerName}`, undefined, { channel: "webchat" });
    return created;
  }

  if (event.conversationId) {
    return { id: event.conversationId };
  }

  const { channel } = event.source;
  const { customerContact, customerName } = event.payload;

  if (!customerContact) {
    return createNewConversation(ctx, channel, customerName, customerContact, undefined, undefined, event.source.connectionId);
  }

  const customerId = await resolveCustomer(ctx, channel, customerContact, customerName);

  const existing = await db.conversation.findFirst({
    where: {
      channel,
      status: { in: ["active", "escalated"] },
      OR: [{ customerId }, { customerContact }],
    },
  });

  return existing ?? (await createNewConversation(ctx, channel, customerName, customerContact, customerId, undefined, event.source.connectionId));
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
  event: ZiyrakEvent<MessageReceivedPayload>
): Promise<OutboundResult> {
  const conversation = await resolveOrCreateConversation(ctx, event);

  // PLAN.md §44.2/§46.6 task 6 — automation's reconnection point. Runs for
  // every inbound message, real side effects (tag/route/alert) applied
  // immediately; a matched auto_reply, if any, short-circuits the AI call
  // below via chat()'s overrideResponse option.
  const matchedActions = await evaluateRules(
    ctx,
    { content: event.payload.text, channel: event.source.channel, customerName: event.payload.customerName },
    { id: conversation.id, channel: event.source.channel, customerName: event.payload.customerName }
  );
  const overrideResponse = await applyAutomationActions(ctx, conversation, matchedActions);

  const response = await chat(ctx, conversation.id, event.payload.text, overrideResponse ? { overrideResponse } : undefined);

  const adapter = getChannelAdapter(event.source.channel);
  const to = event.payload.customerContact;
  if (adapter && to) {
    const sendResult = await adapter.sendMessage(ctx, event.source.connectionId, to, { text: response, metadata: event.metadata });
    if (!sendResult.success) {
      logger.error("[processInboundMessage] failed to deliver reply via channel adapter", {
        businessId: ctx.businessId,
        channel: event.source.channel,
        connectionId: event.source.connectionId,
        conversationId: conversation.id,
        error: sendResult.error,
      });
    }
  }

  return { conversationId: conversation.id, response };
}

jobQueue.registerHandler<ProcessInboundMessagePayload>(PROCESS_INBOUND_MESSAGE_JOB, async (ctx, payload) => {
  const event = await loadReceiptEvent(ctx, payload.receiptId);
  try {
    await processInboundMessage(ctx, event as ZiyrakEvent<MessageReceivedPayload>);
    await markReceiptProcessed(ctx, payload.receiptId, "processed");
  } catch (error) {
    await markReceiptProcessed(ctx, payload.receiptId, "failed");
    logger.error("[processInboundMessage] job failed", { businessId: payload.businessId, receiptId: payload.receiptId, error });
    throw error;
  }
});
