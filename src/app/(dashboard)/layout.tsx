import { Sidebar } from "@/components/layout/sidebar";
import { PermissionsProvider } from "@/components/layout/permissions";
import { MobileNavProvider } from "@/components/layout/mobile-nav";
import { RouteGuard } from "@/components/layout/route-guard";
import { getTenantContextFromCookies } from "@/lib/identity/route-auth";
import { redirect } from "next/navigation";
import { permissionsForContext } from "@/lib/rbac/view";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getTenantContextFromCookies();
  if (!ctx) redirect("/workspaces");
  return (
    <PermissionsProvider permissions={permissionsForContext(ctx)} isOwner={ctx.role === "owner"}>
      <MobileNavProvider>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[60] focus:rounded-md focus:bg-ziyrak-surface focus:px-3 focus:py-2 focus:text-sm focus:text-ziyrak-text focus:shadow-lg"
        >
          Skip to main content
        </a>
        <div className="flex h-full">
          <Sidebar />
          <main id="main-content" tabIndex={-1} className="flex-1 min-w-0 flex flex-col overflow-hidden focus:outline-none">
            <RouteGuard>{children}</RouteGuard>
          </main>
        </div>
      </MobileNavProvider>
    </PermissionsProvider>
  );
}
