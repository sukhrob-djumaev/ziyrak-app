import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/** L5.2 - removals and decreases are scheduled for period end, keep granting until then, and are applied from the provider's answer. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { scheduleReduction, cancelReduction, applyDueReductions } from "@/lib/billing/changes";
import { applyProviderSnapshot } from "@/lib/billing/provider-apply";
import type { PaymentProvider, ProviderSubscription } from "@/lib/billing/providers/types";

const tag = `br-${Date.now()}`;
let biz: string, subId: string;
const v = { bundle: "", seat: "", report: "", team: "" };
const periodEnd = new Date(Date.now() + 10 * 86_400_000);

const snapshot = (items: { itemRef: string; priceRef: string; quantity: number }[]): ProviderSubscription => ({
  ref: `${tag}-sub`, customerRef: `${tag}-cus`, status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: periodEnd, currency: "MYR", items, metadata: {}, fetchedAt: new Date(),
});
const remote = [
  { itemRef: "si_b", priceRef: `${tag}-bundle-p`, quantity: 1 },
  { itemRef: "si_s", priceRef: `${tag}-seat-p`, quantity: 4 },
  { itemRef: "si_r", priceRef: `${tag}-report-p`, quantity: 1 },
  { itemRef: "si_t", priceRef: `${tag}-team-p`, quantity: 3 },
];
const getSubscription = vi.fn(async () => snapshot(remote));
const changeSubscription = vi.fn(async (i: { lines: { priceRef: string; quantity: number; remove?: boolean }[] }) =>
  snapshot(remote.flatMap((r) => { const l = i.lines.find((x) => x.priceRef === r.priceRef); return !l ? [r] : l.remove ? [] : [{ ...r, quantity: l.quantity }]; })),
);
const provider = { name: "stripe", getSubscription, changeSubscription } as unknown as PaymentProvider;
const deps = { provider, mode: "test" as const };
const actor = () => ({ businessId: biz, userId: "u1" });

async function version(key: string, kind: string, grants: unknown) {
  const item = await prisma.catalogItem.create({ data: { key: `${tag}-${key}`, kind } });
  const row = await prisma.catalogVersion.create({ data: { itemId: item.id, version: 1, state: "published", name: key, grants: grants as object, priceMinor: 5000, currency: "MYR", interval: "month", publishedAt: new Date() } });
  await prisma.providerPriceRef.create({ data: { versionId: row.id, provider: "stripe", mode: "test", priceRef: `${tag}-${key}-p`, state: "synced" } });
  return row.id;
}
const itemOf = (versionId: string) => prisma.billingSubscriptionItem.findFirstOrThrow({ where: { subscriptionId: subId, versionId } });

beforeAll(async () => {
  biz = (await prisma.business.create({ data: { name: tag, slug: tag } })).id;
  v.bundle = await version("bundle", "bundle", [{ capability: "channel.webchat" }]);
  v.seat = await version("seat", "addon", [{ capability: "seats.members", amount: 1 }]);
  v.report = await version("report", "addon", [{ capability: "analytics.export" }]);
  v.team = await version("team", "addon", [{ capability: "automation.rules" }]);
  const sub = await prisma.billingSubscription.create({ data: { businessId: biz, provider: "stripe", subscriptionRef: `${tag}-sub`, customerRef: `${tag}-cus`, status: "active", currency: "MYR", currentPeriodEnd: periodEnd } });
  subId = sub.id;
  for (const [id, q] of [[v.bundle, 1], [v.seat, 4], [v.report, 1], [v.team, 3]] as const) await prisma.billingSubscriptionItem.create({ data: { subscriptionId: subId, versionId: id, quantity: q } });
});
afterAll(async () => {
  await prisma.workspacePurchase.deleteMany({ where: { businessId: biz } });
  await prisma.billingSubscription.deleteMany({ where: { businessId: biz } });
  await prisma.billingOperation.deleteMany({ where: { businessId: biz } });
  await prisma.providerPriceRef.deleteMany({ where: { versionId: { in: Object.values(v) } } });
  await prisma.business.deleteMany({ where: { id: biz } });
});

describe("schedule a reduction", () => {
  it("marks the item for period end and keeps it granting", async () => {
    await scheduleReduction(actor(), { lines: [{ versionId: v.report, quantity: 0 }, { versionId: v.team, quantity: 1 }] }, deps);
    const r = await itemOf(v.report);
    expect([r.state, r.pendingQuantity, r.quantity]).toEqual(["scheduled_remove", 0, 1]);
    expect(r.effectiveAt.getTime()).toBe(periodEnd.getTime());
    expect((await itemOf(v.team)).pendingQuantity).toBe(1);
  });

  it("refuses the bundle, an increase and an unknown item", async () => {
    const s = (lines: unknown[]) => scheduleReduction(actor(), { lines }, deps);
    await expect(s([{ versionId: v.bundle, quantity: 0 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(s([{ versionId: v.team, quantity: 5 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(s([{ versionId: "00000000-0000-4000-8000-000000000000", quantity: 0 }])).rejects.toMatchObject({ statusCode: 400 });
  });

  it("a provider snapshot taken before the effective time does not undo the schedule", async () => {
    await prisma.$transaction((tx) => applyProviderSnapshot(tx, snapshot(remote), { businessId: biz, provider: "stripe", mode: "test", graceDays: 7, now: new Date() }));
    expect((await itemOf(v.report)).state).toBe("scheduled_remove");
    const live = await prisma.workspacePurchase.count({ where: { businessId: biz, state: "active", source: "provider", version: { id: v.report } } });
    expect(live).toBe(1);
  });

  it("the owner can cancel a scheduled reduction before it applies", async () => {
    await cancelReduction(actor(), { versionId: v.team });
    const t = await itemOf(v.team);
    expect([t.state, t.pendingQuantity]).toEqual(["active", null]);
  });
});

describe("apply due reductions", () => {
  it("does nothing before the effective time", async () => {
    changeSubscription.mockClear();
    expect(await applyDueReductions(deps, new Date())).toBe(0);
    expect(changeSubscription).not.toHaveBeenCalled();
  });

  it("removes the item at the provider after the effective time and ends its purchase from the answer", async () => {
    const out = await applyDueReductions(deps, new Date(periodEnd.getTime() + 60_000));
    expect(out).toBe(1);
    const sent = changeSubscription.mock.calls[0][0] as { lines: { priceRef: string; itemRef?: string; remove?: boolean }[] };
    expect(sent.lines).toEqual([{ priceRef: `${tag}-report-p`, quantity: 0, itemRef: "si_r", remove: true }]);
    const r = await itemOf(v.report);
    expect([r.state, r.pendingQuantity]).toEqual(["removed", null]);
    expect(await prisma.workspacePurchase.count({ where: { businessId: biz, state: "active", versionId: v.report } })).toBe(0);
  });
});
