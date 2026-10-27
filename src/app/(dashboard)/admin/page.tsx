import { Header } from "@/components/layout/header";
import { redirect } from "next/navigation";
import { getTenantContextFromCookies } from "@/lib/identity/route-auth";
import { hasTenantPermission, validateResourceScope } from "@/lib/tenancy/resource-scope";
import AdminClient from "./admin-client";
import { createHash } from "node:crypto";

export default async function AdminPage() {
  const ctx = await getTenantContextFromCookies();
  if (!ctx) redirect("/workspaces");
  if (!hasTenantPermission(ctx, "admin:read"))
    return (
      <>
        <Header title="People & Access" />
        <div role="alert" className="p-6">
          Access denied. Current workspace administration permission is required.
        </div>
      </>
    );
  const human = ctx.actor.kind === "user";
  const scope = validateResourceScope(ctx.resourceScope);
  // A refreshed selected workspace/session/membership/scope must replace all
  // client rows, forms and generated-key state. The opaque key is only a React
  // lifetime boundary, never authorization or a reusable credential.
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
    <AdminClient
      key={contextKey}
      workspaceId={ctx.businessId}
      capabilities={{
        manageUsers:
          human &&
          scope.kind === "workspace" &&
          hasTenantPermission(ctx, "admin:create") &&
          hasTenantPermission(ctx, "admin:update") &&
          hasTenantPermission(ctx, "admin:delete"),
        createKeys: human && hasTenantPermission(ctx, "admin:create"),
        updateKeys: hasTenantPermission(ctx, "admin:read"),
        deleteKeys: hasTenantPermission(ctx, "admin:delete"),
      }}
    />
  );
}
