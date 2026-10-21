import type { TenantContext } from "./context";
import { effectiveResourceScope } from "./resource-query";
import { AppError } from "@/lib/observability/errors";

/**
 * Configuration that acts on every channel of a workspace (automation rules, flows, webhooks,
 * stored webhook headers and delivery payloads) is not connection-scoped data, so a member
 * restricted to specific channels may not reach it. Fails closed for any non-workspace scope.
 */
export function assertWorkspaceWideAuthority(ctx: TenantContext, subject: string): void {
  if (effectiveResourceScope(ctx).kind !== "workspace")
    throw new AppError(
      403,
      "FORBIDDEN",
      `${subject} requires workspace-wide authority; your access is limited to specific channels`
    );
}
