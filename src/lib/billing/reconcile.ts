import { prisma } from "@/lib/prisma/raw-client";
import { lockTenantWrites } from "@/lib/tenancy/work-lifecycle";
import { applyProviderSnapshot, raiseIncident } from "./provider-apply";
import { processProviderEvent } from "./provider-events";
import { readBillingPolicy } from "./policy";
import type { CheckoutDeps } from "./checkout";

/**
 * L5.2 - control-plane job body: re-reads from the provider every live subscription whose grace has run out or that no snapshot has
 * confirmed lately, so a missed webhook cannot leave access (or a hold) wrong. State comes only from the provider's answer.
 */
export const RECONCILE_STALE_MS = 60 * 60 * 1000;
const BATCH = 50;
/** How long after grace ran out an ended subscription is still checked for a provider-side cancel that failed. */
const CANCEL_RETRY_MS = 14 * 24 * 60 * 60 * 1000;

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
  return repaired + (await sweepStuckEvents(deps, now)) + (await retryGraceCancels(deps, now));
}

/** An event is "stuck" when its job never ran or ran out of retries: the row stays "received" and nothing else would read it. */
const STUCK_EVENT_MS = 10 * 60 * 1000;
const MAX_EVENT_ATTEMPTS = 8;

/** Re-runs events still unprocessed after the job's own retries should have finished; raises an incident once they keep failing. */
async function sweepStuckEvents(deps: CheckoutDeps, now: Date): Promise<number> {
  const events = await prisma.providerEvent.findMany({
    where: { provider: deps.provider.name, state: "received", receivedAt: { lt: new Date(now.getTime() - STUCK_EVENT_MS) } },
    orderBy: { receivedAt: "asc" },
    take: 25,
  });
  let handled = 0;
  for (const ev of events) {
    try {
      await processProviderEvent(ev.id, { provider: deps.provider, providerName: deps.provider.name, mode: deps.mode, now: () => now });
      handled += 1;
    } catch (e) {
      console.error(`[billing-reconcile] event ${ev.eventRef}`, e instanceof Error ? e.message : e);
      // Every failure counts (the processor only counts provider read errors); at the limit the event leaves the sweep for good.
      const fresh = await prisma.providerEvent.findUnique({ where: { id: ev.id }, select: { attempts: true } });
      const attempts = (fresh?.attempts ?? ev.attempts) + (fresh && fresh.attempts !== ev.attempts ? 0 : 1);
      const exhausted = attempts >= MAX_EVENT_ATTEMPTS;
      await prisma.providerEvent.update({
        where: { id: ev.id },
        data: { attempts, ...(exhausted ? { state: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 300) } : {}) },
      });
      if (exhausted) {
        await prisma.$transaction((tx) => raiseIncident(tx, null, "paid_not_provisioned", `event ${ev.eventRef} (${ev.type}) could not be processed after ${MAX_EVENT_ATTEMPTS} attempts`));
      }
    }
  }
  return handled;
}

/** A cancel that failed when grace expired leaves the row ended while the provider keeps billing; stop it here. The key makes a repeat safe. */
async function retryGraceCancels(deps: CheckoutDeps, now: Date): Promise<number> {
  const ended = await prisma.billingSubscription.findMany({
    where: { provider: deps.provider.name, status: "ended", graceEndsAt: { not: null }, updatedAt: { gt: new Date(now.getTime() - CANCEL_RETRY_MS) } },
    orderBy: { updatedAt: "asc" },
    take: BATCH,
  });
  let cancelled = 0;
  for (const row of ended) {
    try {
      const snap = await deps.provider.getSubscription(row.subscriptionRef);
      if (snap.status === "canceled") continue;
      await deps.provider.cancelSubscription({ ref: snap.ref, at: "now" }, `grace-expiry-${snap.ref}`);
      cancelled += 1;
    } catch (e) {
      console.error(`[billing-reconcile] cancel retry ${row.subscriptionRef}`, e instanceof Error ? e.message : e);
    }
  }
  return cancelled;
}
