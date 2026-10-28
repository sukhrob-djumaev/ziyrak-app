import { prisma } from "@/lib/prisma/raw-client";
import { getCustomerAllowanceView } from "@/lib/ai/allowance";
import { CAPABILITIES } from "./capabilities";
import { resolveEntitlements } from "./entitlements";

/**
 * The owner's read-only picture of the package (L4.1b / B02 view part): what the workspace holds, what each capability
 * comes from, seat use, the AI allowance (an estimate, not an invoice) and published add-ons it does not hold. Fixed
 * projection for one workspace: no other tenant's data, no provider references, no financial mutation.
 */
export async function getOfferView(businessId: string, now: Date = new Date()) {
  const [{ effective }, purchases, members, openInvitations, adjustments, allowance, offers] = await Promise.all([
    resolveEntitlements(businessId, now),
    prisma.workspacePurchase.findMany({
      where: { businessId, state: "active", startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      include: { version: { include: { item: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.membership.count({ where: { businessId } }),
    prisma.accountToken.count({ where: { purpose: "invitation", usedAt: null, expiresAt: { gt: now }, payload: { path: ["businessId"], equals: businessId } } }),
    prisma.entitlementAdjustment.findMany({ where: { businessId, expiresAt: { gt: now } }, orderBy: { expiresAt: "asc" } }),
    getCustomerAllowanceView(businessId, now),
    prisma.catalogVersion.findMany({ where: { state: "published", item: { kind: "addon" } }, include: { item: true }, orderBy: { createdAt: "asc" } }),
  ]);
  const heldVersionIds = new Set(purchases.map((p) => p.versionId));
  const held = new Set(purchases.map((p) => p.version.itemId));
  const latestPerItem = new Map<string, (typeof offers)[number]>();
  for (const o of offers) if (!latestPerItem.has(o.itemId) || latestPerItem.get(o.itemId)!.version < o.version) latestPerItem.set(o.itemId, o);
  const seatLimit = effective.get("seats.members")?.limit ?? 0;
  return {
    purchases: purchases.map((p) => ({
      id: p.id,
      itemKey: p.version.item.key,
      kind: p.version.item.kind,
      name: p.version.name,
      version: p.version.version,
      quantity: p.quantity,
      source: p.source,
      since: p.startsAt,
    })),
    capabilities: CAPABILITIES.map((c) => {
      const e = effective.get(c.key);
      return {
        key: c.key,
        label: c.label,
        kind: c.kind,
        granted: e?.granted === true,
        limit: c.kind === "limit" ? e?.limit ?? 0 : null,
        sources: (e?.provenance ?? []).map((s) => s.kind),
      };
    }),
    seats: { members, openInvitations, limit: seatLimit },
    adjustments: adjustments.map((a) => ({ capability: a.capability, granted: a.granted, amount: a.amount, expiresAt: a.expiresAt, reason: a.reason })),
    aiAllowance: allowance && {
      status: allowance.status,
      generation: allowance.generation,
      embedding: allowance.embedding,
      resetsAt: allowance.resetsAt,
      note: "An estimate of service use for this period, not an invoice.",
    },
    availableAddons: [...latestPerItem.values()]
      .filter((o) => !held.has(o.itemId) && !heldVersionIds.has(o.id))
      .map((o) => ({ itemKey: o.item.key, name: o.name, description: o.description, priceMinor: o.priceMinor, currency: o.currency, interval: o.interval, grants: o.grants })),
    note: "Prices are display values. Purchasing is not available yet.",
  };
}
