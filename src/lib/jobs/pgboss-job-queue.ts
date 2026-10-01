import { PgBoss } from "pg-boss";
import type { Job } from "pg-boss";
import type { JobQueue } from "./types";
import type { TenantContext } from "@/lib/tenancy/context";
import { resolveTenantPlacement } from "@/lib/platform/tenant-placement";
import { resolveQueueConfig } from "./queue-config";
import { logger } from "@/lib/observability/logger";

type Handler = (ctx: TenantContext, payload: unknown) => Promise<void>;

/** How many jobs one worker instance pulls and runs in parallel, per queue (see `start()`'s own comment). */
const WORKER_LOCAL_CONCURRENCY = 10;

/**
 * PLAN.md §25.1/§46.6 PR2 — the real, durable `JobQueue` implementation,
 * built and verified against pg-boss's actual installed API (v12,
 * `node_modules/pg-boss/dist/types.d.ts`/`index.d.ts`), not guessed:
 *
 * - `start()`/`createQueue()`/`send()`/`work()` is the library's own
 *   documented pattern (its README's worked example matches exactly).
 * - `createQueue()` is idempotent (`ON CONFLICT DO NOTHING`, verified in
 *   its SQL) — safe to call before every `send`, cached in-memory per
 *   process so it isn't a DB round trip on every call.
 * - `PgBoss#start()` is itself idempotent/concurrency-safe (verified in
 *   its source: a second concurrent caller joins the in-flight promise,
 *   an already-started instance returns immediately) — safe to call from
 *   every `enqueue`/`schedule` without a hand-rolled memoization wrapper.
 * - There is no separate "send one job for later" primitive distinct from
 *   a delayed send — `schedule()` here uses `send(..., { startAfter })`.
 *   pg-boss's own `.schedule()` method is for *recurring* cron/rrule jobs,
 *   which is what `scheduleRecurring()` below calls instead.
 * - §25.6 — pg-boss's own schema lives in the control-plane database
 *   (this class is constructed once against `process.env.DATABASE_URL`,
 *   the same connection the control plane already uses); a job's own
 *   `businessId` is resolved to its `TenantContext`/data-plane connection
 *   inside `runJob()` below, exactly like `FakeJobQueue` already does.
 */
export class PgBossJobQueue implements JobQueue {
  private readonly boss: PgBoss;
  private readonly handlers = new Map<string, Handler>();
  private readonly ensuredQueues = new Set<string>();
  private started = false;

  constructor(connectionString: string) {
    this.boss = new PgBoss({ connectionString });
    this.boss.on("error", (error) => logger.error("[PgBossJobQueue] error", error));
  }

  private async ensureQueue(jobType: string): Promise<void> {
    if (this.ensuredQueues.has(jobType)) return;
    await this.boss.start();
    // pg-boss's own validators check `'retryDelay' in options` etc. (verified
    // in its source, attorney.js) — a key present with value `undefined`
    // still fails validation, so unset options must be omitted entirely,
    // never passed through as `undefined`.
    const { policy, retryLimit, retryBackoff, retryDelay, expireInSeconds } = resolveQueueConfig(jobType);
    const options: Parameters<PgBoss["createQueue"]>[1] = { policy };
    if (retryLimit !== undefined) options.retryLimit = retryLimit;
    if (retryBackoff !== undefined) options.retryBackoff = retryBackoff;
    if (retryDelay !== undefined) options.retryDelay = retryDelay;
    if (expireInSeconds !== undefined) options.expireInSeconds = expireInSeconds;
    await this.boss.createQueue(jobType, options);
    this.ensuredQueues.add(jobType);
  }

  registerHandler<T>(jobType: string, handler: (ctx: TenantContext, payload: T) => Promise<void>): void {
    this.handlers.set(jobType, handler as Handler);
  }

  async enqueue<T>(
    jobType: string,
    payload: T & { businessId: string },
    opts?: { idempotencyKey?: string; singletonKey?: string }
  ): Promise<string> {
    await this.ensureQueue(jobType);
    // §24.4 — an attempt-scoped idempotencyKey has no dedicated pg-boss
    // field; falling back to it as the singletonKey when the caller hasn't
    // set one of its own gives it real dedup value on queues whose policy
    // enforces singleton semantics, and is a harmless no-op on `standard`
    // queues that don't.
    const singletonKey = opts?.singletonKey ?? opts?.idempotencyKey;
    const id = await this.boss.send(jobType, payload, { singletonKey });
    if (id) return id;
    // A queue whose policy allows only one queued job per key ("short",
    // e.g. index-knowledge-entry) answers a duplicate send with null: the
    // work is already waiting. Report that job, not a failure.
    if (singletonKey) {
      const [waiting] = await this.boss.findJobs(jobType, { key: singletonKey, queued: true });
      if (waiting) return waiting.id;
    }
    throw new Error(`PgBossJobQueue: send("${jobType}") did not return a job id.`);
  }

  async schedule<T>(
    jobType: string,
    payload: T & { businessId: string },
    opts: { runAt: Date; idempotencyKey?: string; singletonKey?: string }
  ): Promise<string> {
    await this.ensureQueue(jobType);
    const singletonKey = opts.singletonKey ?? opts.idempotencyKey;
    const id = await this.boss.send(jobType, payload, { startAfter: opts.runAt, singletonKey });
    if (!id) throw new Error(`PgBossJobQueue: send("${jobType}", { startAfter }) did not return a job id.`);
    return id;
  }

  async scheduleRecurring(jobType: string, cronExpression: string, payloadFactory: () => Promise<unknown>): Promise<void> {
    await this.ensureQueue(jobType);
    const payload = (await payloadFactory()) as object | null;
    await this.boss.schedule(jobType, cronExpression, payload ?? {});
  }

  /**
   * PLAN.md §25.3 — called once by the worker process: connects, ensures
   * every registered job type's queue exists, then starts a `work()`
   * poller for each. Never called by the web process, which only
   * enqueues/schedules (§25.3's "separate deployable" split).
   *
   * `localConcurrency` (verified against pg-boss's real `WorkOptions`)
   * governs how many jobs *this one worker* pulls and runs in parallel per
   * queue — it defaults to 1, which would make every queue serialize
   * trivially regardless of key and silently defeat §25.5's own
   * "different conversations process concurrently" half of the ordering
   * guarantee (caught by this phase's own acceptance test). Set explicitly
   * so `key_strict_fifo`'s per-key ordering is the thing actually doing the
   * serializing for same-key jobs, not an accidental one-at-a-time worker.
   */
  async start(): Promise<void> {
    await this.boss.start();
    for (const [jobType, handler] of this.handlers) {
      await this.ensureQueue(jobType);
      await this.boss.work(jobType, { localConcurrency: WORKER_LOCAL_CONCURRENCY }, async (jobs: Job<{ businessId?: string }>[]) => {
        for (const job of jobs) {
          await this.runJob(jobType, job, handler);
        }
      });
    }
    this.started = true;
    logger.info(`[PgBossJobQueue] started, working ${this.handlers.size} job type(s)`, { jobTypes: Array.from(this.handlers.keys()) });
  }

  /**
   * PLAN.md §25.4/§25.6 — resolves the job's own `TenantContext` from its
   * payload's `businessId` before the handler ever touches business data,
   * the same seam a request handler uses (§8). A recurring, platform-wide
   * sweep job (`sweep-sla-breaches`/`sweep-retention`, §25.2) carries no
   * `businessId` at all — it is not itself tenant-scoped, since its own
   * handler iterates every business internally, resolving each one's own
   * placement/context in turn (§25.2's "for each business" sequence) — so
   * this constructs a placeholder, unscoped `ctx` for that case rather than
   * resolving a placement that doesn't exist.
   */
  private async runJob(jobType: string, job: Job<{ businessId?: string }>, handler: Handler): Promise<void> {
    if (!job.data.businessId) {
      const platformCtx: TenantContext = {
        businessId: "",
        role: null,
        actor: { kind: "system_job", jobId: job.id, jobType },
        dataConnection: "shared-default",
      };
      await handler(platformCtx, job.data);
      return;
    }

    const placement = await resolveTenantPlacement(job.data.businessId);
    const ctx: TenantContext = {
      businessId: job.data.businessId,
      role: null,
      actor: { kind: "system_job", jobId: job.id, jobType },
      dataConnection: placement.dataConnection,
    };
    // Throwing here fails this job — pg-boss retries it (per the queue's
    // retryLimit/retryDelay, §31.1) and eventually dead-letters/fails it
    // terminally; it never fails the worker process itself (§31.3's "a
    // single [job type] down must not affect other" principle, applied to
    // jobs the same way it already applies to channels).
    await handler(ctx, job.data);
  }

  /** PLAN.md §25.3/shutdown.ts — graceful drain: stop fetching new jobs, let in-flight handlers finish. */
  async stop(): Promise<void> {
    if (!this.started) {
      await this.boss.stop({ graceful: false, close: true });
      return;
    }
    await this.boss.stop({ graceful: true, timeout: 30000 });
  }
}
