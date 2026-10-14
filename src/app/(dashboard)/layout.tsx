import { Sidebar } from "@/components/layout/sidebar";
import { getTenantContextFromCookies } from "@/lib/identity/route-auth";
import { redirect } from "next/navigation";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  if (!(await getTenantContextFromCookies())) redirect("/workspaces");
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">{children}</main>
    </div>
  );
}
