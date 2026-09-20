import crypto from "crypto";
import type { JobQueue } from "./types";
import type { TenantContext } from "@/lib/tenancy/context";
import { resolveTenantPlacement } from "@/lib/platform/tenant-placement";
import { logger } from "@/lib/observability/logger";

type Handler = (ctx: TenantContext, payload: unknown) => Promise<void>;

/**
 * PLAN.md §25.1/§46.5 — the provisional, in-process `JobQueue` used until
 * Phase 6's real `PgBossJobQueue` exists (§46.6). Its defining property,
 * the one this phase's fast-ack acceptance criterion depends on:
 * `enqueue()` never awaits the handler running to completion — it starts
 * the handler and returns the job id immediately, exactly like a real
 * durable queue's `send()`/`publish()` returns as soon as the job is
 * persisted, long before a worker picks it up. A webhook route that awaits
 * `jobQueue.enqueue(...)` therefore never waits on the AI pipeline inside
 * it (§17.6) — if this class awaited the handler instead, the fast-ack
 * guarantee this phase's acceptance criteria require would be untestable
 * (and, worse, silently false under a slow AI call).
 *
 * `singletonKey` gives same-key jobs their relative order (§25.5's own
 * ordering guarantee is Phase 6 scope; this is only the ordering a fake,
 * one-process queue can cheaply provide without pretending to be more than
 * it is) by chaining each key's jobs onto one promise, without that chain
 * ever blocking `enqueue()`'s own return.
 */
export class FakeJobQueue implements JobQueue {
  private readonly handlers = new Map<string, Handler>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly inFlight = new Set<Promise<void>>();

  registerHandler<T>(jobType: string, handler: (ctx: TenantContext, payload: T) => Promise<void>): void {
    this.handlers.set(jobType, handler as Handler);
  }

  async enqueue<T>(
    jobType: string,
    payload: T & { businessId: string },
    opts?: { idempotencyKey?: string; singletonKey?: string }
  ): Promise<string> {
    const handler = this.handlers.get(jobType);
    if (!handler) {
      throw new Error(`FakeJobQueue: no handler registered for job type "${jobType}". Call registerHandler() before enqueue().`);
    }

    const jobId = crypto.randomUUID();
    const previous = opts?.singletonKey ? (this.chains.get(opts.singletonKey) ?? Promise.resolve()) : Promise.resolve();

    const run: Promise<void> = previous
      .catch(() => {
        // A prior job on the same singletonKey failing must not stall this one.
      })
      .then(async () => {
        const placement = await resolveTenantPlacement(payload.businessId);
        const ctx: TenantContext = {
          businessId: payload.businessId,
          role: null,
          actor: { kind: "system_job", jobId, jobType },
          dataConnection: placement.dataConnection,
        };
        await handler(ctx, payload);
      })
      .catch((error) => {
        logger.error(`[FakeJobQueue] job "${jobType}" (${jobId}) failed`, error);
      });

    if (opts?.singletonKey) this.chains.set(opts.singletonKey, run);
    this.inFlight.add(run);
    run.finally(() => this.inFlight.delete(run));

    return jobId;
  }

  async start(): Promise<void> {
    // No-op: FakeJobQueue dispatches inline as soon as a job is enqueued —
    // there is no separate worker process to start (§25.3 is Phase 6 scope).
  }

  /**
   * Test-only: waits for every job started so far to finish (success or
   * failure). Not part of the `JobQueue` contract — a real durable queue has
   * no equivalent "wait for the in-memory queue to drain" operation, so
   * tests that need to assert a job's *effects* use this instead of a
   * fixed sleep.
   */
  async __drainForTests(): Promise<void> {
    let pending = Array.from(this.inFlight);
    while (pending.length > 0) {
      await Promise.all(pending);
      pending = Array.from(this.inFlight);
    }
  }
}
