import type { TenantContext } from "@/lib/tenancy/context";

/**
 * PLAN.md §46.3 (Phase 3) / §25.1, finalized in §46.6 against pg-boss's
 * real, installed API (`node_modules/pg-boss/dist/types.d.ts`, v12) —
 * `schedule`/`scheduleRecurring` added now that `PgBossJobQueue` (Phase 6)
 * implements this contract for real. Handlers take `ctx` as an explicit
 * first parameter (§16.3) — never resolved implicitly inside the handler.
 */
export interface JobQueue {
  enqueue<T>(
    jobType: string,
    payload: T & { businessId: string },
    opts?: { idempotencyKey?: string; singletonKey?: string }
  ): Promise<string>;
  /**
   * Enqueues a job to run at (or after) `runAt` — a durable delayed send,
   * not a recurring schedule (that's `scheduleRecurring` below). Maps
   * directly onto pg-boss's own `send(name, data, { startAfter })`; there
   * is no separate "schedule one job for later" primitive in its real API
   * distinct from a delayed send. This is what `schedule_followup` (§24.3,
   * PR3) calls.
   */
  schedule<T>(
    jobType: string,
    payload: T & { businessId: string },
    opts: { runAt: Date; idempotencyKey?: string; singletonKey?: string }
  ): Promise<string>;
  /**
   * Registers a cron-recurring job (`sweep-sla-breaches`, `sweep-retention`,
   * §25.2). `payloadFactory` is called once, when the recurring schedule is
   * registered (worker startup) — pg-boss's own `schedule()` stores one
   * static payload per cron registration, not a per-fire dynamic one
   * (verified against its real API/types, not assumed). This is a
   * deliberate, narrow implementation detail, not a contract change: both
   * recurring jobs this codebase has are platform-wide sweeps that re-query
   * "which businesses need attention right now" from inside the handler at
   * fire time (§25.2's own table) — neither needs per-fire payload data, so
   * a payload resolved once at registration is functionally equivalent to
   * "fresh every time" for every real caller.
   */
  scheduleRecurring(jobType: string, cronExpression: string, payloadFactory: () => Promise<unknown>): Promise<void>;
  registerHandler<T>(jobType: string, handler: (ctx: TenantContext, payload: T) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
