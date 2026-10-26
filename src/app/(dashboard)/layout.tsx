import { Sidebar } from "@/components/layout/sidebar";
import { PermissionsProvider } from "@/components/layout/permissions";
import { getTenantContextFromCookies } from "@/lib/identity/route-auth";
import { redirect } from "next/navigation";
import { permissionsForContext } from "@/lib/rbac/view";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getTenantContextFromCookies();
  if (!ctx) redirect("/workspaces");
  return (
    <PermissionsProvider permissions={permissionsForContext(ctx)}>
      <div className="flex h-full">
        <Sidebar />
        <main className="flex-1 flex flex-col overflow-hidden">{children}</main>
      </div>
    </PermissionsProvider>
  );
}
