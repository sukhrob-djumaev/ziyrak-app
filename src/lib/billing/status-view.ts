import { prisma } from "@/lib/prisma/raw-client";
import { paymentHold } from "./payment-hold";
import type { BillingMode } from "./providers";

/**
 * L5.1 - what the owner's billing page needs to subscribe and to see the subscription's state: the latest published,
 * provider-synced version of each item that can be sold now, the workspace's current subscription, and the hold.
 */
export async function getBillingStatus(businessId: string, provider: { name: string; mode: BillingMode } | null) {
  const [hold, subscription, suspended] = await Promise.all([
    paymentHold(businessId),
    prisma.billingSubscription.findFirst({
      where: { businessId, status: { not: "ended" } },
      orderBy: { createdAt: "desc" },
      include: { items: { where: { state: { not: "removed" } }, include: { version: { include: { item: true } } } } },
    }),
    prisma.membership.findMany({
      where: { businessId, suspendedByPlanAt: { not: null } },
      orderBy: { suspendedByPlanAt: "asc" },
      select: { id: true, role: true, user: { select: { name: true, email: true } } },
    }),
  ]);
  const versions = provider
    ? await prisma.catalogVersion.findMany({
        where: { state: "published", priceRefs: { some: { provider: provider.name, mode: provider.mode, state: "synced" } } },
        include: { item: true },
        orderBy: { version: "desc" },
      })
    : [];
  const latest = new Map<string, (typeof versions)[number]>();
  for (const v of versions) if (!latest.has(v.itemId)) latest.set(v.itemId, v);
  return {
    providerEnabled: provider !== null,
    hold: { held: hold.held, retentionEndsAt: hold.held ? hold.retentionEndsAt : null },
    subscription: subscription && {
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      graceEndsAt: subscription.graceEndsAt,
      currency: subscription.currency,
      items: subscription.items.map((i) => ({
        versionId: i.versionId,
        name: i.version.name,
        kind: i.version.item.kind,
        quantity: i.quantity,
        state: i.state,
        pendingQuantity: i.state === "scheduled_remove" ? i.pendingQuantity : null,
        effectiveAt: i.state === "scheduled_remove" ? i.effectiveAt : null,
      })),
    },
    suspendedMembers: suspended.map((m) => ({ membershipId: m.id, role: m.role, name: m.user.name, email: m.user.email })),
    sellable: [...latest.values()].map((v) => ({
      versionId: v.id,
      itemKey: v.item.key,
      kind: v.item.kind,
      name: v.name,
      description: v.description,
      priceMinor: v.priceMinor,
      currency: v.currency,
      interval: v.interval,
    })),
  };
}
