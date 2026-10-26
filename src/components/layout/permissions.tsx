"use client";

import { createContext, useContext, useMemo } from "react";
import type { Permission } from "@/lib/rbac/rbac";

/**
 * The permissions the server derived for the signed-in member, passed down from the dashboard layout.
 * This only decides what to show; every API still enforces the real check.
 */
const PermissionsContext = createContext<ReadonlySet<Permission>>(new Set());

export function PermissionsProvider({ permissions, children }: { permissions: Permission[]; children: React.ReactNode }) {
  const value = useMemo(() => new Set<Permission>(permissions), [permissions]);
  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

export function useCan(permission: Permission): boolean {
  return useContext(PermissionsContext).has(permission);
}

export function usePermissions(): ReadonlySet<Permission> {
  return useContext(PermissionsContext);
}
