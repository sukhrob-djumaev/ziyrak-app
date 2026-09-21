import crypto from "crypto";
import type { JobQueue } from "./types";
import type { TenantContext } from "@/lib/tenancy/context";
import { resolveTenantPlacement } from "@/lib/platform/tenant-placement";
import { logger } from "@/lib/observability/logger";

type Handler = (ctx: TenantContext, payload: unknown) => Promise<void>;

/**
 * PLAN.md §25.1/§46.5/§46.6 — the provisional, in-process `JobQueue` used
 * by the default test suite (§34.2/§35 — "FakeJobQueue for the default
 * suite; a real pg-boss instance... for Phase 6's specific acceptance
 * tests") and, before this phase, by every environment. Its defining
 * property, the one this phase's fast-ack acceptance criterion depends on:
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
 * ordering guarantee is proven against real `PgBossJobQueue` in Phase 6's
 * own acceptance suite; this is only the ordering a fake, one-process queue
 * can cheaply provide without pretending to be more than it is) by
 * chaining each key's jobs onto one promise, without that chain ever
 * blocking `enqueue()`'s own return.
 */
export class FakeJobQueue implements JobQueue {
  private readonly handlers = new Map<string, Handler>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

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

  /**
   * PLAN.md §46.6 — a delayed one-off send, matching `PgBossJobQueue`'s own
   * `send(..., { startAfter })`-based implementation closely enough that
   * `schedule_followup` (PR3) exercises the same call shape against either.
   * The delay is real (`setTimeout`), not simulated/instant, so a test
   * asserting "not yet delivered" before the delay and "delivered" after it
   * (via a fake/advanceable timer, or `__drainForTests()` after fast-
   * forwarding) observes genuinely different states — never awaited by
   * this method itself, preserving the same non-blocking `enqueue()` contract.
   */
  async schedule<T>(
    jobType: string,
    payload: T & { businessId: string },
    opts: { runAt: Date; idempotencyKey?: string; singletonKey?: string }
  ): Promise<string> {
    const handler = this.handlers.get(jobType);
    if (!handler) {
      throw new Error(`FakeJobQueue: no handler registered for job type "${jobType}". Call registerHandler() before schedule().`);
    }

    const jobId = crypto.randomUUID();
    const delayMs = Math.max(0, opts.runAt.getTime() - Date.now());

    const run: Promise<void> = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, delayMs);
      this.timers.add(timer);
    })
      .then(async () => {
        const previous = opts.singletonKey ? (this.chains.get(opts.singletonKey) ?? Promise.resolve()) : Promise.resolve();
        await previous.catch(() => {});
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
        logger.error(`[FakeJobQueue] scheduled job "${jobType}" (${jobId}) failed`, error);
      });

    if (opts.singletonKey) this.chains.set(opts.singletonKey, run);
    this.inFlight.add(run);
    run.finally(() => this.inFlight.delete(run));

    return jobId;
  }

  /**
   * Not meaningfully fakeable — a recurring cron schedule firing
   * repeatedly, unattended, is exactly the behavior `PgBossJobQueue`'s own
   * (already-proven, upstream-tested) implementation provides; the default
   * test suite exercises `sweep-sla-breaches`/`sweep-retention`'s actual
   * sweep logic by calling their registered handler directly, not by
   * waiting on a simulated cron tick. This records the registration (so a
   * test can assert one was attempted) without ever firing it.
   */
  async scheduleRecurring(jobType: string, cronExpression: string, payloadFactory: () => Promise<unknown>): Promise<void> {
    await payloadFactory();
    logger.info(`[FakeJobQueue] scheduleRecurring("${jobType}", "${cronExpression}") registered but will not fire — use the registered handler directly in tests.`);
  }

  async start(): Promise<void> {
    // No-op: FakeJobQueue dispatches inline as soon as a job is enqueued —
    // there is no separate worker process to start (§25.3 is real-queue,
    // real-worker scope, exercised against PgBossJobQueue directly).
  }

  /** Cancels any pending delayed (`schedule()`) timers and waits for in-flight work to settle. */
  async stop(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await this.__drainForTests();
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
