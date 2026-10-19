/**
 * Real-time Event System
 *
 * Server-Sent Events (SSE) based real-time updates.
 * Lighter than WebSocket, works with Next.js edge runtime,
 * and doesn't require socket.io dependency.
 */

import { redisKeyPrefix, redisUrl } from "@/lib/redis/client";
import { InMemoryRealtimeBus } from "./in-memory-bus";
import { RedisRealtimeBus } from "./redis-bus";

export type EventType =
  | "message:new"
  | "message:updated"
  | "conversation:new"
  | "conversation:updated"
  | "conversation:assigned"
  | "ticket:new"
  | "ticket:updated"
  | "typing:start"
  | "typing:stop"
  | "agent:online"
  | "agent:offline"
  | "notification";

export interface EventPayload {
  type: EventType;
  data: Record<string, unknown>;
  timestamp: string;
  conversationId?: string;
}

type EventCallback = (event: EventPayload) => void;

let bus: InMemoryRealtimeBus<EventPayload> | RedisRealtimeBus<EventPayload> | null = null;

/**
 * PLAN.md §26.1/§46.8 — the selected `RealtimeBus`: Redis Pub/Sub when
 * `REDIS_URL` is set (so every replica's dashboard clients see every
 * replica's events), the in-memory bus otherwise (single replica, local
 * default). Mirrors `cache.ts`'s selection pattern.
 */
function getBus() {
  if (!bus) {
    const url = redisUrl();
    bus = url
      ? new RedisRealtimeBus<EventPayload>({ url, prefix: `${redisKeyPrefix()}rt:` })
      : new InMemoryRealtimeBus<EventPayload>();
  }
  return bus;
}

/**
 * Subscribe to real-time events.
 * Returns an unsubscribe function.
 */
export function subscribe(
  channel: string,
  callback: EventCallback
): () => void {
  return getBus().subscribe(channel, callback);
}

function deliverTo(channel: string, payload: EventPayload): void {
  void getBus().publish(channel, payload);
}

const TENANT_CHANNEL_PREFIX = /^(tenant:[^:]+:)(.+)$/;

/**
 * Publish an event to all subscribers on a channel.
 *
 * PLAN.md §26.2 — channel names are mandatorily tenant-prefixed
 * (`tenant:<businessId>:global`, `tenant:<businessId>:conversation:<id>`),
 * built by the `emit*` helpers below, never a bare `global`. Publishing to
 * a tenant-prefixed channel also notifies that *same tenant's* global
 * channel — never the bare, unscoped `global` a pre-Phase-2 subscriber
 * might still be listening on, which is exactly the cross-tenant leak this
 * fix closes (a `global` subscription no longer receives every business's
 * events system-wide).
 */
export function publish(channel: string, event: Omit<EventPayload, "timestamp">): void {
  const payload: EventPayload = {
    ...event,
    timestamp: new Date().toISOString(),
  };

  deliverTo(channel, payload);

  const tenantMatch = channel.match(TENANT_CHANNEL_PREFIX);
  if (tenantMatch) {
    const tenantGlobalChannel = `${tenantMatch[1]}global`;
    if (channel !== tenantGlobalChannel) deliverTo(tenantGlobalChannel, payload);
  } else if (channel !== "global") {
    // Non-tenant-prefixed channel (ad-hoc/test usage only, §26.2 forbids
    // this shape for real application channels) — preserve the old
    // "also notify the bare global channel" behavior for that narrow case.
    deliverTo("global", payload);
  }
}

/** PLAN.md §26.2 — the only two channel shapes application code may use. */
export function tenantGlobalChannel(businessId: string): string {
  return `tenant:${businessId}:global`;
}

export function tenantConversationChannel(businessId: string, conversationId: string): string {
  return `tenant:${businessId}:conversation:${conversationId}`;
}

/**
 * Helper: Emit a new message event. `businessId` is required (§26.2) — every
 * emit helper takes it explicitly, the same explicit-`ctx`-at-boundaries
 * discipline as the rest of Phase 2 (§8.2/§16), so a caller cannot
 * accidentally publish to an unscoped channel.
 */
export function emitNewMessage(
  businessId: string,
  conversationId: string,
  message: { id: string; role: string; content: string }
): void {
  publish(tenantConversationChannel(businessId, conversationId), {
    type: "message:new",
    conversationId,
    data: message,
  });
  publish(tenantGlobalChannel(businessId), {
    type: "message:new",
    conversationId,
    data: { conversationId, messageId: message.id, role: message.role },
  });
}

/** A conversation was opened; the dashboard lists it without a refresh. */
export function emitNewConversation(businessId: string, conversationId: string, data: Record<string, unknown> = {}): void {
  publish(tenantGlobalChannel(businessId), { type: "conversation:new", conversationId, data: { conversationId, ...data } });
}

/** Something needs a person's attention (e.g. an AI action waiting for approval). */
export function emitNotification(businessId: string, kind: string, data: Record<string, unknown> = {}): void {
  publish(tenantGlobalChannel(businessId), { type: "notification", data: { kind, ...data } });
}

/**
 * Helper: Emit typing indicator.
 */
export function emitTyping(
  businessId: string,
  conversationId: string,
  userName: string,
  isTyping: boolean
): void {
  publish(tenantConversationChannel(businessId, conversationId), {
    type: isTyping ? "typing:start" : "typing:stop",
    conversationId,
    data: { userName },
  });
}

/**
 * Helper: Emit conversation update.
 */
export function emitConversationUpdate(
  businessId: string,
  conversationId: string,
  changes: Record<string, unknown>
): void {
  publish(tenantGlobalChannel(businessId), {
    type: "conversation:updated",
    conversationId,
    data: changes,
  });
}

/**
 * Get subscriber count for monitoring (this process's subscribers).
 */
export function getSubscriberCount(): number {
  return getBus().subscriberCount();
}
