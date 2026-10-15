import { Header } from "@/components/layout/header";
import { getTenantContextFromCookies } from "@/lib/identity/route-auth";
import { hasTenantPermission, validateResourceScope } from "@/lib/tenancy/resource-scope";
import { createHash } from "node:crypto";
import { redirect } from "next/navigation";
import SettingsClient from "./settings-client";

export default async function SettingsPage() {
  const ctx = await getTenantContextFromCookies();
  if (!ctx) redirect("/workspaces");
  if (!hasTenantPermission(ctx, "settings:read"))
    return (
      <>
        <Header title="Settings" />
        <div role="alert" className="p-6">
          Access denied. Current workspace settings permission is required.
        </div>
      </>
    );
  const scope = validateResourceScope(ctx.resourceScope);
  // A refreshed identity, workspace or authority replaces every form, pending
  // request and typed credential. This opaque lifetime key grants no authority.
  const contextKey = createHash("sha256")
    .update(
      JSON.stringify({
        businessId: ctx.businessId,
        actor: ctx.actor,
        role: ctx.role,
        dataConnection: ctx.dataConnection,
        authorization: ctx.authorization,
        scope:
          scope.kind === "connections"
            ? { ...scope, connectionIds: [...scope.connectionIds].sort() }
            : scope,
      })
    )
    .digest("hex");
  return (
    <SettingsClient
      key={contextKey}
      workspaceId={ctx.businessId}
      canUpdate={hasTenantPermission(ctx, "settings:update")}
    />
  );
}
