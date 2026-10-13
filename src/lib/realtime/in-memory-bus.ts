import { logger } from "@/lib/observability/logger";
import type { RealtimeBus } from "./types";

/**
 * PLAN.md §26.1 — the single-replica `RealtimeBus` (the local default). Also
 * the local fan-out half of `RedisRealtimeBus`: delivery to this process's
 * own subscribers is always synchronous, so behavior for a single replica
 * is identical whichever bus is selected.
 */
export class InMemoryRealtimeBus<T = unknown> implements RealtimeBus<T> {
  private readonly subscribers = new Map<string, Set<(event: T) => void>>();

  async publish(channel: string, event: T): Promise<void> {
    // Delivered before the first await, so a caller that ignores the
    // returned promise (the fire-and-forget `publish()` facade) still gets
    // synchronous local delivery.
    this.deliver(channel, event);
  }

  subscribe(channel: string, callback: (event: T) => void): () => void {
    let subs = this.subscribers.get(channel);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(channel, subs);
    }
    subs.add(callback);

    return () => {
      const current = this.subscribers.get(channel);
      if (!current) return;
      current.delete(callback);
      if (current.size === 0) this.subscribers.delete(channel);
    };
  }

  /** Deliver to this process's subscribers only. */
  deliver(channel: string, event: T): void {
    const subs = this.subscribers.get(channel);
    if (!subs) return;
    for (const callback of [...subs]) {
      try {
        callback(event);
      } catch (error) {
        logger.error(`SSE subscriber callback error (channel: ${channel})`, error);
      }
    }
  }

  /** Channels that currently have at least one local subscriber. */
  channels(): string[] {
    return [...this.subscribers.keys()];
  }

  subscriberCount(): number {
    let count = 0;
    for (const subs of this.subscribers.values()) count += subs.size;
    return count;
  }
}
