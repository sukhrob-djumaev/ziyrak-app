import { PERMISSIONS, hasPermission, type Permission } from "@/lib/rbac/rbac";
import type { TenantContext } from "@/lib/tenancy/context";
import { hasTenantPermission } from "@/lib/tenancy/resource-scope";
import { effectiveResourceScope } from "@/lib/tenancy/resource-query";

const ALL = Object.keys(PERMISSIONS) as Permission[];

/** Areas whose APIs call assertWorkspaceWideAuthority: a member limited to specific channels cannot use them. */
const WORKSPACE_WIDE_ONLY = /^(webhooks|automation):/;

/** The permissions a role holds, for the dashboard to show only what the APIs will accept. Display only: every API still enforces. */
export function permissionsForRole(role: string): Permission[] {
  return ALL.filter((p) => hasPermission(role, p));
}

/** Same, for a resolved request context (honours support/delegated grants and channel-scoped members). */
export function permissionsForContext(ctx: TenantContext): Permission[] {
  let workspaceWide = true;
  try {
    workspaceWide = effectiveResourceScope(ctx).kind === "workspace";
  } catch {
    workspaceWide = false; // no usable scope: show nothing scope-dependent
  }
  return ALL.filter((p) => hasTenantPermission(ctx, p) && (workspaceWide || !WORKSPACE_WIDE_ONLY.test(p)));
}
