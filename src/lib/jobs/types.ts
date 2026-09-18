import type { TenantContext } from "@/lib/tenancy/context";

/**
 * PLAN.md §46.3 (Phase 3) / §25.1 — module-boundary sketch, not a frozen
 * contract. Per review concern 22, Phase 3 fixes only this contract's
 * module location (`jobs/`, new) and that it depends on nothing else in
 * this codebase (§6). No implementation exists yet; that is Phase 6 scope
 * (§46.6, `PgBossJobQueue`). Handlers take `ctx` as an explicit first
 * parameter (§16.3) — never resolved implicitly inside the handler.
 */
export interface JobQueue {
  enqueue<T>(
    jobType: string,
    payload: T & { businessId: string },
    opts?: { idempotencyKey?: string; singletonKey?: string }
  ): Promise<string>;
  registerHandler<T>(jobType: string, handler: (ctx: TenantContext, payload: T) => Promise<void>): void;
  start(): Promise<void>;
}
