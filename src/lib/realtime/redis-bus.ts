import { randomUUID } from "node:crypto";
import { logger } from "@/lib/observability/logger";
import { createRedisClient, withTimeout } from "@/lib/redis/client";
import { InMemoryRealtimeBus } from "./in-memory-bus";
import type { RealtimeBus } from "./types";

const SETTLE_TIMEOUT_MS = 15_000;

interface Envelope<T> {
  /** Publishing instance, so it can skip the copy Redis echoes back to it. */
  o: string;
  e: T;
}

/**
 * PLAN.md §26.1/§46.8 — `RealtimeBus` over Redis Pub/Sub, so an event
 * published on one replica reaches dashboard clients connected to any other.
 *
 * - Best-effort by contract (§17.3): Pub/Sub is fire-and-forget, a failed
 *   publish is logged and dropped, and the durable write has already
 *   happened. A Redis outage costs notifications, never data.
 * - Local subscribers are always served directly and synchronously, never
 *   through Redis, so a single replica behaves exactly as with the
 *   in-memory bus and the publisher ignores its own echo.
 * - A Redis channel is subscribed only while this replica has a local
 *   subscriber for it, so a replica is not woken for tenants it doesn't
 *   serve. Subscriptions are reconciled on every (re)connect.
 */
export class RedisRealtimeBus<T = unknown> implements RealtimeBus<T> {
  private readonly local = new InMemoryRealtimeBus<T>();
  private readonly instanceId: string;
  private readonly prefix: string;
  private readonly pub: ReturnType<typeof createRedisClient>;
  private readonly sub: ReturnType<typeof createRedisClient>;
  private readonly connected: Promise<unknown>;
  private readonly redisSubscribed = new Set<string>();
  private ops: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(opts: { url: string; prefix: string; instanceId?: string }) {
    this.instanceId = opts.instanceId ?? randomUUID();
    this.prefix = opts.prefix;
    this.pub = createRedisClient(opts.url);
    this.sub = createRedisClient(opts.url);
    // The client retries by itself while Redis is unreachable; once it is
    // ready (first connect or any reconnect) re-assert the subscriptions.
    this.sub.on("ready", () => this.enqueue(() => this.reconcile()));
    this.connected = Promise.all([this.pub.connect(), this.sub.connect()]).catch((error) => {
      logger.warn("[RedisRealtimeBus] initial connect failed, retrying in background", { error: String(error) });
    });
  }

  async publish(channel: string, event: T): Promise<void> {
    this.local.deliver(channel, event);
    if (this.closed || !this.pub.isReady) return;
    try {
      const envelope: Envelope<T> = { o: this.instanceId, e: event };
      await this.pub.publish(this.prefix + channel, JSON.stringify(envelope));
    } catch (error) {
      logger.warn("[RedisRealtimeBus] publish failed (best-effort, dropped)", { channel, error: String(error) });
    }
  }

  subscribe(channel: string, callback: (event: T) => void): () => void {
    const unsubscribeLocal = this.local.subscribe(channel, callback);
    this.enqueue(() => this.reconcile());
    return () => {
      unsubscribeLocal();
      this.enqueue(() => this.reconcile());
    };
  }

  subscriberCount(): number {
    return this.local.subscriberCount();
  }

  /** Resolves once connected and every subscribe/unsubscribe so far is in effect. */
  async settled(): Promise<void> {
    await withTimeout(this.connected.then(() => this.ops), SETTLE_TIMEOUT_MS);
    // a 'ready'-triggered reconcile may have been queued while waiting
    await this.ops;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.ops.catch(() => {});
    await Promise.allSettled([this.pub.isOpen ? this.pub.close() : undefined, this.sub.isOpen ? this.sub.close() : undefined]);
  }

  private enqueue(op: () => Promise<void>): void {
    this.ops = this.ops.then(op).catch((error) => {
      logger.warn("[RedisRealtimeBus] subscription update failed", { error: String(error) });
    });
  }

  /** Make Redis's subscriptions equal the channels with a local subscriber. */
  private async reconcile(): Promise<void> {
    if (this.closed || !this.sub.isReady) return;
    const wanted = new Set(this.local.channels());
    for (const channel of wanted) {
      if (this.redisSubscribed.has(channel)) continue;
      await this.sub.subscribe(this.prefix + channel, (message) => this.onMessage(channel, message));
      this.redisSubscribed.add(channel);
    }
    for (const channel of [...this.redisSubscribed]) {
      if (wanted.has(channel)) continue;
      await this.sub.unsubscribe(this.prefix + channel);
      this.redisSubscribed.delete(channel);
    }
  }

  private onMessage(channel: string, message: string): void {
    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(message) as Envelope<T>;
    } catch {
      return;
    }
    if (envelope.o === this.instanceId) return;
    this.local.deliver(channel, envelope.e);
  }
}
