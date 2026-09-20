import type { TenantContext } from "@/lib/tenancy/context";
import { jobQueue, PROCESS_INBOUND_MESSAGE_JOB, type ProcessInboundMessagePayload } from "@/lib/jobs/queue";
import "@/lib/jobs/bootstrap";
import type { ZiyrakEvent, MessageReceivedPayload } from "./types";

/**
 * PLAN.md §6 (`events/` owns "event dispatch"), §17.4/§17.6/§46.5 — the one
 * remaining step after a `ChannelAdapter.validateInbound()` call returns
 * `{kind: "new", ...}` (verification, `ChannelConnection` resolution, and
 * `InboundEventReceipt` dedup/persistence all already happened inside
 * `validateInbound` itself, per §19.1's own three-way return type): enqueue
 * the durable processing job and return, so the webhook route's next line
 * is always its ACK — never `processInboundMessage` run inline (§17.6).
 *
 * `singletonKey` groups jobs for the same conversation (falling back to the
 * customer contact when no conversation is known yet, e.g. a brand-new
 * customer's first message) so `FakeJobQueue`/Phase 6's `PgBossJobQueue`
 * can serialize them (§25.5) without this call site needing to change.
 */
export async function enqueueInboundProcessing(
  ctx: TenantContext,
  receiptId: string,
  event: ZiyrakEvent<MessageReceivedPayload>
): Promise<string> {
  return jobQueue.enqueue<ProcessInboundMessagePayload>(
    PROCESS_INBOUND_MESSAGE_JOB,
    { businessId: ctx.businessId, receiptId },
    { singletonKey: `${ctx.businessId}:${event.conversationId ?? event.payload.customerContact}` }
  );
}
