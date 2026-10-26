import { PERMISSIONS, hasPermission, type Permission } from "@/lib/rbac/rbac";
import type { TenantContext } from "@/lib/tenancy/context";
import { hasTenantPermission } from "@/lib/tenancy/resource-scope";

const ALL = Object.keys(PERMISSIONS) as Permission[];

/** The permissions a role holds, for the dashboard to show only what the APIs will accept. Display only: every API still enforces. */
export function permissionsForRole(role: string): Permission[] {
  return ALL.filter((p) => hasPermission(role, p));
}

/** Same, for a resolved request context (honours support/delegated grants). */
export function permissionsForContext(ctx: TenantContext): Permission[] {
  return ALL.filter((p) => hasTenantPermission(ctx, p));
}
