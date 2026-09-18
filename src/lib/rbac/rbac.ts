/**
 * Role-Based Access Control (RBAC) System
 *
 * Roles: owner > admin > supervisor > agent > viewer
 * Each role inherits all permissions of the roles below it.
 *
 * PLAN.md §9.1 — `owner` is a fifth, business-scoped-only role added above
 * `admin` for the handful of operations that must have exactly one
 * accountable party per business (deleting the business, transferring
 * ownership, billing). It inherits every `admin` permission and adds a
 * small set of owner-only ones.
 *
 * `platform_admin` (§9.1/§15.2) is deliberately NOT part of this role
 * hierarchy: a platform administrator gets no tenant-resource permission
 * implicitly. It is authorized through a structurally separate check in
 * `route-auth.ts`, never through `hasPermission()`/`PERMISSIONS` below —
 * that is the concrete mechanism that keeps "platform admin" from becoming
 * "admin for every tenant" (§15.2).
 */

export const ROLES = ["viewer", "agent", "supervisor", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

// Named role-set shorthands so "owner inherits every admin permission" is
// structural (adding a permission to STAFF_ROLES/ADMIN_ROLES automatically
// covers owner too) rather than something every entry below has to remember.
const ALL_ROLES = ["viewer", "agent", "supervisor", "admin", "owner"] as const;
const STAFF_ROLES = ["agent", "supervisor", "admin", "owner"] as const;
const SUPERVISOR_ROLES = ["supervisor", "admin", "owner"] as const;
const ADMIN_ROLES = ["admin", "owner"] as const;
const OWNER_ONLY = ["owner"] as const;

export const PERMISSIONS = {
  // Conversations
  "conversations:read": ALL_ROLES,
  "conversations:create": STAFF_ROLES,
  "conversations:update": STAFF_ROLES,
  "conversations:delete": SUPERVISOR_ROLES,
  "conversations:assign": SUPERVISOR_ROLES,
  "conversations:transfer": STAFF_ROLES,

  // Messages
  "messages:read": ALL_ROLES,
  "messages:create": STAFF_ROLES,

  // Tickets
  "tickets:read": ALL_ROLES,
  "tickets:create": STAFF_ROLES,
  "tickets:update": STAFF_ROLES,
  "tickets:delete": SUPERVISOR_ROLES,

  // Customers
  "customers:read": ALL_ROLES,
  "customers:create": STAFF_ROLES,
  "customers:update": STAFF_ROLES,
  "customers:delete": ADMIN_ROLES,
  "customers:export": SUPERVISOR_ROLES,

  // Knowledge Base
  "knowledge:read": ALL_ROLES,
  "knowledge:create": SUPERVISOR_ROLES,
  "knowledge:update": SUPERVISOR_ROLES,
  "knowledge:delete": ADMIN_ROLES,

  // Team Management
  "team:read": ALL_ROLES,
  "team:create": ADMIN_ROLES,
  "team:update": ADMIN_ROLES,
  "team:delete": ADMIN_ROLES,

  // Automation
  "automation:read": ALL_ROLES,
  "automation:create": SUPERVISOR_ROLES,
  "automation:update": SUPERVISOR_ROLES,
  "automation:delete": ADMIN_ROLES,

  // Webhooks
  "webhooks:read": SUPERVISOR_ROLES,
  "webhooks:create": ADMIN_ROLES,
  "webhooks:update": ADMIN_ROLES,
  "webhooks:delete": ADMIN_ROLES,

  // Settings
  "settings:read": ADMIN_ROLES,
  "settings:update": ADMIN_ROLES,

  // Admin (users, API keys)
  "admin:read": ADMIN_ROLES,
  "admin:create": ADMIN_ROLES,
  "admin:update": ADMIN_ROLES,
  "admin:delete": ADMIN_ROLES,

  // Analytics
  "analytics:read": ALL_ROLES,
  "analytics:export": SUPERVISOR_ROLES,

  // Activity Log
  "activity:read": SUPERVISOR_ROLES,

  // Channels
  "channels:read": SUPERVISOR_ROLES,
  "channels:update": ADMIN_ROLES,

  // SLA
  "sla:read": ALL_ROLES,
  "sla:create": ADMIN_ROLES,
  "sla:update": ADMIN_ROLES,
  "sla:delete": ADMIN_ROLES,

  // Business Hours
  "business-hours:read": ALL_ROLES,
  "business-hours:update": ADMIN_ROLES,

  // Canned Responses
  "canned:read": STAFF_ROLES,
  "canned:create": SUPERVISOR_ROLES,
  "canned:update": SUPERVISOR_ROLES,
  "canned:delete": ADMIN_ROLES,

  // Export
  "export:read": SUPERVISOR_ROLES,

  // Business (owner-only, §9.1)
  "business:delete": OWNER_ONLY,
  "business:transfer-ownership": OWNER_ONLY,
  "business:billing": OWNER_ONLY,
} as const;

export type Permission = keyof typeof PERMISSIONS;

/**
 * Check if a role has a specific permission.
 */
export function hasPermission(role: string, permission: Permission): boolean {
  const allowed = PERMISSIONS[permission];
  if (!allowed) return false;
  return (allowed as readonly string[]).includes(role);
}

/**
 * Check if a role meets the minimum required role level.
 */
export function hasMinRole(role: string, minRole: Role): boolean {
  const roleIndex = ROLES.indexOf(role as Role);
  const minIndex = ROLES.indexOf(minRole);
  if (roleIndex === -1 || minIndex === -1) return false;
  return roleIndex >= minIndex;
}

/**
 * Get all permissions for a role.
 */
export function getPermissionsForRole(role: string): Permission[] {
  return (Object.entries(PERMISSIONS) as [Permission, readonly string[]][])
    .filter(([, roles]) => roles.includes(role))
    .map(([perm]) => perm);
}
