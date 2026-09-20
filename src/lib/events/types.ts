import crypto from "crypto";

/**
 * PLAN.md §17.1/§46.5 — the normalized inbound event envelope, finalized in
 * this phase (§46.3 fixed only this module's location/dependency direction:
 * `events/` depends on nothing else in this codebase). Every channel
 * adapter's `validateInbound()` produces one of these; `processInboundMessage`
 * (`conversations/inbound.ts`) is the only consumer that acts on it.
 *
 * Deliberately a typed discriminated union (`type` + `payload`), not a bare
 * `Record<string, unknown>` blob (§17.1's own wording) — `MessageReceived`
 * is the only event type this phase's channels produce; future producers
 * (a CRM webhook, a calendar integration) extend the union rather than
 * loosening it.
 */
export interface MessageReceivedPayload {
  text: string;
  customerName: string;
  customerContact: string;
  mediaType?: string;
  mediaUrl?: string;
}

export interface ZiyrakEvent<T = unknown> {
  id: string;
  type: string;
  businessId: string;
  source: { channel: string; connectionId: string; externalId?: string };
  subjectCustomerId?: string;
  conversationId?: string;
  occurredAt: string;
  receivedAt: string;
  correlationId: string;
  causationId?: string;
  payload: T;
  metadata?: Record<string, unknown>;
}

export type MessageReceivedEvent = ZiyrakEvent<MessageReceivedPayload>;

/**
 * Builds a `message.received` event with fresh `id`/`correlationId`/
 * `receivedAt`, defaulting `occurredAt` to now unless the provider supplied
 * its own timestamp. Every adapter's `validateInbound()` should go through
 * this rather than constructing the envelope by hand, so the id/timestamp
 * conventions stay identical across channels.
 */
export function buildMessageReceivedEvent(input: {
  businessId: string;
  channel: string;
  connectionId: string;
  externalId?: string;
  occurredAt?: string;
  conversationId?: string;
  subjectCustomerId?: string;
  payload: MessageReceivedPayload;
  metadata?: Record<string, unknown>;
}): MessageReceivedEvent {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    type: "message.received",
    businessId: input.businessId,
    source: { channel: input.channel, connectionId: input.connectionId, externalId: input.externalId },
    subjectCustomerId: input.subjectCustomerId,
    conversationId: input.conversationId,
    occurredAt: input.occurredAt ?? now,
    receivedAt: now,
    correlationId: crypto.randomUUID(),
    payload: input.payload,
    metadata: input.metadata,
  };
}
