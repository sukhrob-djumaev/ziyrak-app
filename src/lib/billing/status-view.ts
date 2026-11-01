import { prisma } from "@/lib/prisma/raw-client";
import { paymentHold } from "./payment-hold";
import type { BillingMode } from "./providers";

/**
 * L5.1 - what the owner's billing page needs to subscribe and to see the subscription's state: the latest published,
 * provider-synced version of each item that can be sold now, the workspace's current subscription, and the hold.
 */
export async function getBillingStatus(businessId: string, provider: { name: string; mode: BillingMode } | null) {
  const [hold, subscription] = await Promise.all([
    paymentHold(businessId),
    prisma.billingSubscription.findFirst({
      where: { businessId, status: { not: "ended" } },
      orderBy: { createdAt: "desc" },
      include: { items: { where: { state: { not: "removed" } }, include: { version: { include: { item: true } } } } },
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
      items: subscription.items.map((i) => ({ name: i.version.name, kind: i.version.item.kind, quantity: i.quantity, state: i.state })),
    },
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
