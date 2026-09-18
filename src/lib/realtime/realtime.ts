/**
 * Real-time Event System
 *
 * Server-Sent Events (SSE) based real-time updates.
 * Lighter than WebSocket, works with Next.js edge runtime,
 * and doesn't require socket.io dependency.
 */

import { logger } from "@/lib/observability/logger";

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

interface EventPayload {
  type: EventType;
  data: Record<string, unknown>;
  timestamp: string;
  conversationId?: string;
}

type EventCallback = (event: EventPayload) => void;

// In-memory subscriber registry
const subscribers = new Map<string, Set<EventCallback>>();

/**
 * Subscribe to real-time events.
 * Returns an unsubscribe function.
 */
export function subscribe(
  channel: string,
  callback: EventCallback
): () => void {
  if (!subscribers.has(channel)) {
    subscribers.set(channel, new Set());
  }
  subscribers.get(channel)!.add(callback);

  return () => {
    const subs = subscribers.get(channel);
    if (subs) {
      subs.delete(callback);
      if (subs.size === 0) subscribers.delete(channel);
    }
  };
}

function deliverTo(channel: string, payload: EventPayload): void {
  const subs = subscribers.get(channel);
  if (!subs) return;
  for (const callback of subs) {
    try {
      callback(payload);
    } catch (error) {
      logger.error(`SSE subscriber callback error (channel: ${channel})`, error);
    }
  }
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
 * Get subscriber count for monitoring.
 */
export function getSubscriberCount(): number {
  let count = 0;
  for (const subs of subscribers.values()) {
    count += subs.size;
  }
  return count;
}
