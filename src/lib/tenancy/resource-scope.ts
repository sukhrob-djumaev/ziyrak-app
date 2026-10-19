import { AppError } from "@/lib/observability/errors";
import type { Permission } from "@/lib/rbac/rbac";
import { hasPermission } from "@/lib/rbac/rbac";
import type { TenantContext } from "./context";

export type CustomerProfileCapability = "none" | "read" | "write";
export type ResourceScope =
  | { kind: "workspace"; customerProfileAccess: CustomerProfileCapability }
  | {
      kind: "connections";
      connectionIds: string[];
      customerProfileAccess: CustomerProfileCapability;
    };
export const WORKSPACE_SCOPE: ResourceScope = { kind: "workspace", customerProfileAccess: "write" };

export function validateResourceScope(input: unknown): ResourceScope {
  if (!input || typeof input !== "object")
    throw new AppError(403, "INVALID_SCOPE", "Explicit resource scope is required");
  const scope = input as Record<string, unknown>;
  const profile = scope.customerProfileAccess ?? "none";
  if (!["none", "read", "write"].includes(profile as string))
    throw new AppError(403, "INVALID_SCOPE", "Invalid customer profile capability");
  if (scope.kind === "workspace")
    return { kind: "workspace", customerProfileAccess: profile as CustomerProfileCapability };
  if (
    scope.kind !== "connections" ||
    !Array.isArray(scope.connectionIds) ||
    scope.connectionIds.some((id) => typeof id !== "string" || !id || id.length > 128)
  )
    throw new AppError(403, "INVALID_SCOPE", "Invalid connection scope");
  return {
    kind: "connections",
    connectionIds: [...new Set(scope.connectionIds as string[])],
    customerProfileAccess: profile as CustomerProfileCapability,
  };
}
export function scopeFromRecord(record: {
  scopeMode: string;
  customerProfileAccess: string;
  connectionScopes?: { connectionId: string }[];
}): ResourceScope {
  return validateResourceScope({
    kind: record.scopeMode,
    customerProfileAccess: record.customerProfileAccess,
    connectionIds: record.connectionScopes?.map((row) => row.connectionId) ?? [],
  });
}
export function scopeIsWithin(scope: ResourceScope, ceiling: ResourceScope): boolean {
  const rank = { none: 0, read: 1, write: 2 };
  if (rank[scope.customerProfileAccess] > rank[ceiling.customerProfileAccess]) return false;
  if (ceiling.kind === "workspace") return true;
  return (
    scope.kind === "connections" &&
    scope.connectionIds.every((id) => ceiling.connectionIds.includes(id))
  );
}
/** A connection-time/job ceiling cannot grow when current authority grows. */
export function intersectResourceScopes(
  current: ResourceScope,
  ceiling: ResourceScope
): ResourceScope {
  const rank = { none: 0, read: 1, write: 2 };
  const customerProfileAccess =
    rank[current.customerProfileAccess] < rank[ceiling.customerProfileAccess]
      ? current.customerProfileAccess
      : ceiling.customerProfileAccess;
  if (current.kind === "workspace" && ceiling.kind === "workspace")
    return { kind: "workspace", customerProfileAccess };
  const connectionIds =
    current.kind === "connections"
      ? current.connectionIds.filter(
          (id) => ceiling.kind === "workspace" || ceiling.connectionIds.includes(id)
        )
      : ceiling.kind === "connections"
        ? ceiling.connectionIds
        : [];
  return { kind: "connections", connectionIds: [...connectionIds], customerProfileAccess };
}
export function hasTenantPermission(ctx: TenantContext, permission: Permission): boolean {
  if (ctx.authorization?.kind === "support")
    return (
      ctx.actor.kind === "platform_admin" &&
      ctx.authorization.allowedOperations.includes(permission)
    );
  if (ctx.authorization?.kind === "delegated_job")
    return (
      ctx.actor.kind === "system_job" && ctx.authorization.allowedOperations.includes(permission)
    );
  return hasPermission(ctx.role ?? "", permission);
}
export function assertProfileCapability(ctx: TenantContext, write = false): void {
  const scope = validateResourceScope(ctx.resourceScope);
  if (scope.customerProfileAccess === "none" || (write && scope.customerProfileAccess !== "write"))
    throw new AppError(403, "FORBIDDEN", "Shared customer profile permission is required");
}
