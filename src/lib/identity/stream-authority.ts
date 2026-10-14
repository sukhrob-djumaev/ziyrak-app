import type { NextRequest } from "next/server";
import { requireAuth, isAuthenticated } from "./route-auth";
import type { TenantContext } from "@/lib/tenancy/context";
import {
  hasTenantPermission,
  intersectResourceScopes,
  validateResourceScope,
} from "@/lib/tenancy/resource-scope";
import type { Permission } from "@/lib/rbac/rbac";

/** Reauthenticates the established request, never a new workspace locator.
 * This is for live requests; durable jobs require their own saved provenance.
 */
export async function refreshStreamAuthority(
  request: NextRequest,
  ceiling: TenantContext
): Promise<TenantContext | null> {
  const current = await requireAuth(request, "conversations:read");
  if (
    !isAuthenticated(current) ||
    current.businessId !== ceiling.businessId ||
    current.actor.kind !== ceiling.actor.kind
  )
    return null;
  const initial = ceiling.authorization,
    fresh = current.authorization;
  if (!initial || !fresh || initial.kind !== fresh.kind) return null;
  if (
    initial.kind === "membership" &&
    (fresh.kind !== "membership" ||
      fresh.membershipId !== initial.membershipId ||
      fresh.userId !== initial.userId ||
      fresh.sessionJti !== initial.sessionJti)
  )
    return null;
  if (
    initial.kind === "api_key" &&
    (fresh.kind !== "api_key" || fresh.apiKeyId !== initial.apiKeyId)
  )
    return null;
  if (
    initial.kind === "support" &&
    (fresh.kind !== "support" ||
      fresh.grantId !== initial.grantId ||
      fresh.userId !== initial.userId ||
      fresh.sessionJti !== initial.sessionJti)
  )
    return null;
  if (initial.kind === "delegated_job") return null;
  return {
    ...current,
    resourceScope: intersectResourceScopes(
      validateResourceScope(current.resourceScope),
      validateResourceScope(ceiling.resourceScope)
    ),
  };
}
export function streamPermission(
  current: TenantContext,
  ceiling: TenantContext,
  permission: Permission
) {
  return hasTenantPermission(current, permission) && hasTenantPermission(ceiling, permission);
}
