import { AsyncLocalStorage } from "node:async_hooks";

/**
 * PLAN.md §9.5 — who/what is acting, independent of RBAC. `user`/`api_key`
 * are authorized via `hasPermission(role, permission)` (§9.3); `ai_agent`/
 * `system_job` are never authorized through RBAC at all (§15.4) — that is
 * `ToolPolicy`, Phase 6 scope. `platform_admin` gets no tenant-resource
 * permission implicitly (§15.2).
 */
export type ExecutionPrincipal =
  | { kind: "user"; userId: string }
  | { kind: "api_key"; apiKeyId: string }
  | { kind: "channel_credential"; channelConnectionId: string }
  | { kind: "ai_agent"; conversationId: string; model: string }
  | { kind: "system_job"; jobId: string; jobType: string }
  | { kind: "platform_admin"; userId: string };

/**
 * PLAN.md §8.2 — explicit at every service boundary (`serviceFn(ctx, ...)`).
 * `AsyncLocalStorage` (below) is a narrowly-scoped backstop only, never the
 * primary way business logic learns its own tenant.
 */
export interface TenantContext {
  businessId: string;
  role: string | null;
  actor: ExecutionPrincipal;
  dataConnection: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

/**
 * Called once, at the true edge (a worker's job-pickup, or the Prisma
 * extension's own fail-closed backstop test harness) — NOT sprinkled through
 * business logic, which should already have `ctx` explicitly in scope.
 */
export function runWithTenantContext<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Backstop only (§8.2b/c) — used by `getScopedPrisma()` when it is ever
 * called without an explicit `ctx` (a bug), and by structured logging (§37)
 * to attach `businessId`/`correlationId` without threading a logger
 * parameter through every call. Application/service code should not need
 * this — it should already have `ctx` as an explicit parameter.
 */
export function getBackstopTenantContext(): TenantContext | undefined {
  return storage.getStore();
}
