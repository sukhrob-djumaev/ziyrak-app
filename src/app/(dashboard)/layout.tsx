import { Sidebar } from "@/components/layout/sidebar";
import { getTenantContextFromCookies } from "@/lib/identity/route-auth";
import { redirect } from "next/navigation";
import { hasTenantPermission } from "@/lib/tenancy/resource-scope";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getTenantContextFromCookies();
  if (!ctx) redirect("/workspaces");
  return (
    <div className="flex h-full">
      <Sidebar canReadAdministration={hasTenantPermission(ctx, "admin:read")} />
      <main className="flex-1 flex flex-col overflow-hidden">{children}</main>
    </div>
  );
}
