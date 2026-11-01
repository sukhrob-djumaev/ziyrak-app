import type { Prisma } from "@/generated/prisma/client";
import { applySnapshot, type ApplyResult, type LocalStatus } from "./subscription-state";
import type { ProviderSubscription } from "./providers/types";

/**
 * L5.1 - applies one authoritative provider snapshot to the local subscription, its items and the provider-sourced
 * purchases (docs/l5-payment-lifecycle-design.md Revisions 2-3). The caller owns the transaction and has taken
 * `lockTenantWrites` for the workspace; nothing here talks to the provider. State comes only from the snapshot,
 * so replays and reordered snapshots converge.
 */
type Tx = Prisma.TransactionClient;

export interface ApplyContext {
  businessId: string;
  provider: string;
  mode: "test" | "live";
  graceDays: number;
  now: Date;
  /** Operation that created this subscription; only set on first bind. */
  operationId?: string;
}

export interface ApplyOutcome extends Pick<ApplyResult, "cancelAtProvider" | "incident" | "stale" | "grantsAccess"> {
  subscriptionId: string;
  status: LocalStatus;
}

export async function raiseIncident(tx: Tx, businessId: string | null, kind: string, detail: string): Promise<void> {
  const open = await tx.billingIncident.findFirst({ where: { businessId, kind, detail, state: "open" }, select: { id: true } });
  if (!open) await tx.billingIncident.create({ data: { businessId, kind, detail: detail.slice(0, 500) } });
}

export async function applyProviderSnapshot(tx: Tx, snap: ProviderSubscription, ctx: ApplyContext): Promise<ApplyOutcome> {
  let row = await tx.billingSubscription.findUnique({ where: { provider_subscriptionRef: { provider: ctx.provider, subscriptionRef: snap.ref } } });
  if (row && row.businessId !== ctx.businessId) {
    // The ref is already bound elsewhere; never move it.
    await raiseIncident(tx, ctx.businessId, "unbound_ref", `subscription ${snap.ref} is bound to another workspace`);
    return { subscriptionId: row.id, status: row.status as LocalStatus, grantsAccess: false, cancelAtProvider: false, incident: null, stale: true };
  }
  if (!row) {
    row = await tx.billingSubscription.create({
      data: { businessId: ctx.businessId, provider: ctx.provider, subscriptionRef: snap.ref, customerRef: snap.customerRef, operationId: ctx.operationId ?? null, status: "incomplete", currency: snap.currency },
    });
  }

  const result = applySnapshot(
    { status: row.status as LocalStatus, graceEndsAt: row.graceEndsAt, lastFetchedAt: row.lastFetchedAt },
    { providerStatus: snap.status, cancelAtPeriodEnd: snap.cancelAtPeriodEnd, currentPeriodEnd: snap.currentPeriodEnd, fetchedAt: snap.fetchedAt },
    { graceDays: ctx.graceDays },
    ctx.now,
  );
  const outcome: ApplyOutcome = { subscriptionId: row.id, status: result.state.status, grantsAccess: result.grantsAccess, cancelAtProvider: result.cancelAtProvider, incident: result.incident, stale: result.stale };
  if (result.stale) return outcome;

  await tx.billingSubscription.update({
    where: { id: row.id },
    data: {
      status: result.state.status,
      graceEndsAt: result.state.graceEndsAt,
      lastFetchedAt: result.state.lastFetchedAt,
      currentPeriodEnd: snap.currentPeriodEnd,
      currency: snap.currency,
      customerRef: snap.customerRef,
      rev: { increment: 1 },
    },
  });
  if (result.incident) await raiseIncident(tx, ctx.businessId, result.incident, `subscription ${snap.ref} reported paid after it ended`);

  // Items: map each provider price to the catalog version it was synced from; an unmapped price grants nothing.
  const seen = new Set<string>();
  for (const it of snap.items) {
    const ref = await tx.providerPriceRef.findFirst({ where: { provider: ctx.provider, mode: ctx.mode, priceRef: it.priceRef }, select: { versionId: true } });
    if (!ref) {
      await raiseIncident(tx, ctx.businessId, "unbound_ref", `price ${it.priceRef} on subscription ${snap.ref} is not a synced catalog version`);
      continue;
    }
    seen.add(ref.versionId);
    const existing = await tx.billingSubscriptionItem.findFirst({ where: { subscriptionId: row.id, versionId: ref.versionId } });
    if (existing) {
      // A scheduled reduction stays scheduled until the provider reports the reduced quantity.
      const scheduled = existing.state === "scheduled_remove" && existing.pendingQuantity != null && it.quantity > existing.pendingQuantity;
      await tx.billingSubscriptionItem.update({
        where: { id: existing.id },
        data: scheduled ? { quantity: it.quantity } : { quantity: it.quantity, state: "active", pendingQuantity: null },
      });
    }
    else await tx.billingSubscriptionItem.create({ data: { subscriptionId: row.id, versionId: ref.versionId, quantity: it.quantity } });
  }
  await tx.billingSubscriptionItem.updateMany({ where: { subscriptionId: row.id, state: { in: ["active", "scheduled_remove"] }, versionId: { notIn: [...seen] } }, data: { state: "removed", pendingQuantity: null } });

  await syncPurchases(tx, ctx, row.id, result.grantsAccess, snap.currentPeriodEnd);
  return outcome;
}

async function syncPurchases(tx: Tx, ctx: ApplyContext, subscriptionId: string, grants: boolean, periodEnd: Date): Promise<void> {
  const items = await tx.billingSubscriptionItem.findMany({ where: { subscriptionId }, include: { version: { include: { item: true } } } });
  for (const item of items) {
    const live = await tx.workspacePurchase.findMany({ where: { subscriptionItemId: item.id, state: "active" } });
    const want = grants && (item.state === "active" || item.state === "scheduled_remove");
    if (!want) {
      if (live.length) await tx.workspacePurchase.updateMany({ where: { id: { in: live.map((p) => p.id) } }, data: { state: "ended", endsAt: ctx.now } });
      continue;
    }
    if (live.length === 1 && live[0].quantity === item.quantity) continue;
    if (live.length) await tx.workspacePurchase.updateMany({ where: { id: { in: live.map((p) => p.id) } }, data: { state: "ended", endsAt: ctx.now } });
    if (item.version.item.kind === "bundle") {
      // A paid bundle replaces the non-provider bundle the workspace held; it is never stacked on top.
      await tx.workspacePurchase.updateMany({
        where: { businessId: ctx.businessId, state: "active", source: { in: ["baseline", "manual_test"] }, version: { item: { kind: "bundle" } } },
        data: { state: "ended", endsAt: ctx.now },
      });
    }
    await tx.workspacePurchase.create({
      data: { businessId: ctx.businessId, versionId: item.versionId, quantity: item.quantity, source: "provider", subscriptionItemId: item.id, reason: `provider:${subscriptionId}`, endsAt: null },
    });
  }
  void periodEnd;
}
