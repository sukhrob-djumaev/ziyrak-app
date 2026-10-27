"use client";

import { createContext, useContext, useMemo } from "react";
import type { Permission } from "@/lib/rbac/rbac";

/**
 * The permissions the server derived for the signed-in member, passed down from the dashboard layout.
 * This only decides what to show; every API still enforces the real check.
 */
const PermissionsContext = createContext<ReadonlySet<Permission>>(new Set());
const OwnerContext = createContext(false);

export function PermissionsProvider({ permissions, isOwner = false, children }: { permissions: Permission[]; isOwner?: boolean; children: React.ReactNode }) {
  const value = useMemo(() => new Set<Permission>(permissions), [permissions]);
  return (
    <PermissionsContext.Provider value={value}>
      <OwnerContext.Provider value={isOwner}>{children}</OwnerContext.Provider>
    </PermissionsContext.Provider>
  );
}

/** Whether the member is the workspace owner (the server checks the same thing for onboarding actions). */
export function useIsOwner(): boolean {
  return useContext(OwnerContext);
}

export function useCan(permission: Permission): boolean {
  return useContext(PermissionsContext).has(permission);
}

export function usePermissions(): ReadonlySet<Permission> {
  return useContext(PermissionsContext);
}
