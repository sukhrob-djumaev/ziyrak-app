import { z } from "zod";
import { AppError, NotFoundError } from "@/lib/observability/errors";
import { withPlatformControl } from "@/lib/platform/access/authority";
import { writePlatformAudit } from "@/lib/platform/access/audit";
import { lockTenantWrites } from "@/lib/tenancy/work-lifecycle";
import { applyProviderSnapshot } from "./provider-apply";
import { readBillingPolicy } from "./policy";
import type { CheckoutDeps } from "./checkout";
import type { ProviderSubscription } from "./providers/types";

/**
 * L5.2 - super-admin repair for a workspace whose provider state and local state disagree (a paid event with no purchase). It re-reads every live subscription from the provider and applies the answer exactly as the
 * reconcile job would, so it can only converge on what the provider reports; it moves no money and sets no state by hand.
 * Open incidents of the repairable kinds are resolved (tenant-binding alerts such as `unbound_ref` stay open for review) only once the re-read succeeded for every subscription.
 */
const repairInput = z.object({ businessId: z.string().min(1).max(128), reason: z.string().trim().min(1).max(1000) }).strict();
const REPAIRABLE = ["paid_not_provisioned", "reconcile_mismatch"];

export async function repairProvision(token: string, input: unknown, deps: CheckoutDeps, now: Date = new Date()) {
  const r = repairInput.safeParse(input);
  if (!r.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid repair request");
  const { businessId, reason } = r.data;

  const refs = await withPlatformControl(token, "super_admin", async (tx) => {
    if (!(await tx.business.findUnique({ where: { id: businessId }, select: { id: true } }))) throw new NotFoundError("Workspace");
    const rows = await tx.billingSubscription.findMany({ where: { businessId, provider: deps.provider.name, status: { not: "ended" } }, select: { subscriptionRef: true } });
    return rows.map((s) => s.subscriptionRef);
  });
  if (refs.length === 0) throw new AppError(409, "CONFLICT", "This workspace has no live subscription to repair");

  const snaps: ProviderSubscription[] = [];
  for (const ref of refs) snaps.push(await deps.provider.getSubscription(ref));

  return withPlatformControl(token, "super_admin", async (tx, actor) => {
    await lockTenantWrites(tx, businessId);
    const policy = await readBillingPolicy(tx);
    const outcomes = [];
    for (const snap of snaps) {
      outcomes.push(await applyProviderSnapshot(tx, snap, { businessId, provider: deps.provider.name, mode: deps.mode, graceDays: policy.graceDays, now }));
    }
    const resolved = await tx.billingIncident.updateMany({
      where: { businessId, state: "open", kind: { in: REPAIRABLE } },
      data: { state: "resolved", resolvedBy: actor.userId, resolvedAt: now },
    });
    await writePlatformAudit(tx, { actorUserId: actor.userId, action: "billing.repair", reason, businessId, details: { subscriptions: refs.length, incidentsResolved: resolved.count } });
    return { subscriptions: outcomes.length, incidentsResolved: resolved.count };
  });
}
