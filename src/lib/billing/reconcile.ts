import { prisma } from "@/lib/prisma/raw-client";
import { lockTenantWrites } from "@/lib/tenancy/work-lifecycle";
import { applyProviderSnapshot } from "./provider-apply";
import { readBillingPolicy } from "./policy";
import type { CheckoutDeps } from "./checkout";

/**
 * L5.2 - control-plane job body: re-reads from the provider every live subscription whose grace has run out or that no snapshot has
 * confirmed lately, so a missed webhook cannot leave access (or a hold) wrong. State comes only from the provider's answer.
 */
export const RECONCILE_STALE_MS = 60 * 60 * 1000;
const BATCH = 50;

export async function reconcileSubscriptions(deps: CheckoutDeps, now: Date = new Date()): Promise<number> {
  const stale = new Date(now.getTime() - RECONCILE_STALE_MS);
  const rows = await prisma.billingSubscription.findMany({
    where: {
      provider: deps.provider.name,
      status: { not: "ended" },
      OR: [{ status: "past_due", graceEndsAt: { lte: now } }, { lastFetchedAt: null }, { lastFetchedAt: { lt: stale } }],
    },
    orderBy: { lastFetchedAt: { sort: "asc", nulls: "first" } },
    take: BATCH,
  });
  let repaired = 0;
  for (const row of rows) {
    try {
      const snap = await deps.provider.getSubscription(row.subscriptionRef);
      const outcome = await prisma.$transaction(async (tx) => {
        await lockTenantWrites(tx, row.businessId);
        const policy = await readBillingPolicy(tx);
        return applyProviderSnapshot(tx, snap, { businessId: row.businessId, provider: deps.provider.name, mode: deps.mode, graceDays: policy.graceDays, now });
      });
      if (outcome.cancelAtProvider) await deps.provider.cancelSubscription({ ref: snap.ref, at: "now" }, `grace-expiry-${snap.ref}`);
      repaired += 1;
    } catch (e) {
      // One workspace's provider error must not stop the rest; the next run retries it.
      console.error(`[billing-reconcile] ${row.subscriptionRef}`, e instanceof Error ? e.message : e);
    }
  }
  return repaired;
}
