"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCan } from "@/components/layout/permissions";
import { permissionForPath } from "@/lib/navigation/dashboard-nav";
import type { Permission } from "@/lib/rbac/rbac";

function Denied({ name }: { name: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div role="alert" data-testid="access-denied" className="max-w-md text-center">
        <h2 className="text-lg font-semibold text-ziyrak-text">Access denied</h2>
        <p className="mt-2 text-sm text-ziyrak-text-light">
          Your role in this workspace does not include {name}. A workspace owner or admin can change your role.
        </p>
        <Link href="/" className="mt-4 inline-block text-sm font-medium text-ziyrak-primary hover:underline">
          Back to the dashboard
        </Link>
      </div>
    </div>
  );
}

function Gate({ permission, name, children }: { permission: Permission; name: string; children: React.ReactNode }) {
  return useCan(permission) ? <>{children}</> : <Denied name={name} />;
}

/** Shows an explicit denial, instead of a page full of failing requests, when the role lacks the page's read permission. The API still enforces. */
export function RouteGuard({ children }: { children: React.ReactNode }) {
  const need = permissionForPath(usePathname());
  if (!need) return <>{children}</>;
  return (
    <Gate permission={need.permission} name={need.name}>
      {children}
    </Gate>
  );
}
