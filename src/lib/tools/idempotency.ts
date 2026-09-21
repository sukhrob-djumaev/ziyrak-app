import type { TenantContext } from "@/lib/tenancy/context";
import type { ToolRuntimeContext } from "./types";

/**
 * PLAN.md §24.4 (review concern 10's redesign) — identifies a specific
 * *execution attempt*, never a hash of arguments. A client-supplied key
 * (API/manual calls) wins when present; otherwise the AI provider's own
 * `toolCallId` (stable across a retried completion call, §21.3) scopes the
 * attempt. Neither is available only when a caller invokes the registry
 * outside both paths — a programming error, not a runtime condition to
 * degrade gracefully from.
 */
export function computeIdempotencyKey(ctx: TenantContext, runtimeCtx: ToolRuntimeContext): string {
  if (runtimeCtx.idempotencyKey) return runtimeCtx.idempotencyKey;
  if (runtimeCtx.toolCallId) return `${ctx.businessId}:${runtimeCtx.toolCallId}`;
  throw new Error("No idempotency key available — every ActionExecution requires one (PLAN.md §24.4).");
}
