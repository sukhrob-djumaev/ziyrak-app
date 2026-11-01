import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/** L5.1 - applying provider snapshots: purchases follow the subscription, stale snapshots are ignored, no baseline re-grant. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { applyProviderSnapshot } from "@/lib/billing/provider-apply";
import type { ProviderSubscription } from "@/lib/billing/providers/types";

const tag = `ba-${Date.now()}`;
const T0 = new Date("2026-11-01T00:00:00Z");
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);
let biz: string;
let otherBiz: string;
let versionId: string;
let itemId: string;

const snap = (over: Partial<ProviderSubscription> = {}): ProviderSubscription => ({
  ref: `${tag}-sub`,
  customerRef: `${tag}-cus`,
  status: "active",
  cancelAtPeriodEnd: false,
  currentPeriodEnd: day(30),
  currency: "MYR",
  items: [{ itemRef: "si_1", priceRef: `${tag}-price`, quantity: 1 }],
  metadata: {},
  fetchedAt: day(0),
  ...over,
});
const ctx = (businessId: string, now: Date) => ({ businessId, provider: "stripe", mode: "test" as const, graceDays: 7, now });
const apply = (s: ProviderSubscription, now = day(0), businessId = biz) =>
  prisma.$transaction((tx) => applyProviderSnapshot(tx, s, ctx(businessId, now)));
const livePurchases = () => prisma.workspacePurchase.findMany({ where: { businessId: biz, source: "provider", state: "active" } });

beforeAll(async () => {
  biz = (await prisma.business.create({ data: { name: `${tag}-a`, slug: `${tag}-a` } })).id;
  otherBiz = (await prisma.business.create({ data: { name: `${tag}-b`, slug: `${tag}-b` } })).id;
  const item = await prisma.catalogItem.create({ data: { key: `${tag}-bundle`, kind: "bundle" } });
  itemId = item.id;
  const v = await prisma.catalogVersion.create({ data: { itemId, version: 1, state: "published", name: "T", grants: [{ capability: "channel.webchat" }], priceMinor: 19900, currency: "MYR", interval: "month", publishedAt: new Date() } });
  versionId = v.id;
  await prisma.providerPriceRef.create({ data: { versionId, provider: "stripe", mode: "test", priceRef: `${tag}-price`, state: "synced" } });
});

afterAll(async () => {
  const ids = [biz, otherBiz];
  await prisma.workspacePurchase.deleteMany({ where: { businessId: { in: ids } } });
  await prisma.billingIncident.deleteMany({ where: { businessId: { in: ids } } });
  await prisma.billingSubscription.deleteMany({ where: { businessId: { in: ids } } });
  await prisma.providerPriceRef.deleteMany({ where: { versionId } });
  await prisma.business.deleteMany({ where: { id: { in: ids } } });
});

describe("applyProviderSnapshot", () => {
  it("an active snapshot creates the subscription, its item and one provider purchase", async () => {
    const out = await apply(snap());
    expect(out.grantsAccess).toBe(true);
    const p = await livePurchases();
    expect(p).toHaveLength(1);
    expect(p[0].versionId).toBe(versionId);
    expect(p[0].subscriptionItemId).not.toBeNull();
  });

  it("replaying the same snapshot changes nothing", async () => {
    await apply(snap({ fetchedAt: day(1) }), day(1));
    expect(await livePurchases()).toHaveLength(1);
  });

  it("a stale snapshot is ignored", async () => {
    const out = await apply(snap({ status: "canceled" as never, fetchedAt: day(0) }), day(2));
    expect(out.stale).toBe(true);
    expect(await livePurchases()).toHaveLength(1);
  });

  it("a quantity change ends and recreates the purchase", async () => {
    await apply(snap({ fetchedAt: day(3), items: [{ itemRef: "si_1", priceRef: `${tag}-price`, quantity: 3 }] }), day(3));
    const p = await livePurchases();
    expect(p).toHaveLength(1);
    expect(p[0].quantity).toBe(3);
  });

  it("past_due keeps access inside the grace window and records graceEndsAt once", async () => {
    await apply(snap({ status: "past_due", fetchedAt: day(4) }), day(4));
    const first = (await prisma.billingSubscription.findFirstOrThrow({ where: { businessId: biz } })).graceEndsAt;
    expect(first).not.toBeNull();
    await apply(snap({ status: "past_due", fetchedAt: day(5) }), day(5));
    const again = (await prisma.billingSubscription.findFirstOrThrow({ where: { businessId: biz } })).graceEndsAt;
    expect(again?.getTime()).toBe(first?.getTime());
    expect(await livePurchases()).toHaveLength(1);
  });

  it("an ended subscription ends the provider purchase and grants no baseline back", async () => {
    await apply(snap({ status: "canceled" as never, fetchedAt: day(6) }), day(6));
    expect(await livePurchases()).toHaveLength(0);
    const baseline = await prisma.workspacePurchase.count({ where: { businessId: biz, source: "baseline", state: "active" } });
    expect(baseline).toBe(0);
  });

  it("an unknown price grants nothing and raises one incident", async () => {
    const s = snap({ ref: `${tag}-sub2`, fetchedAt: day(7), items: [{ itemRef: "si_x", priceRef: "price_unknown", quantity: 1 }] });
    await apply(s, day(7), otherBiz);
    await apply({ ...s, fetchedAt: day(8) }, day(8), otherBiz);
    expect(await prisma.workspacePurchase.count({ where: { businessId: otherBiz, source: "provider" } })).toBe(0);
    expect(await prisma.billingIncident.count({ where: { businessId: otherBiz, kind: "unbound_ref", state: "open" } })).toBe(1);
  });

  it("never moves a subscription ref bound to another workspace", async () => {
    const out = await apply(snap({ fetchedAt: day(9) }), day(9), otherBiz);
    expect(out.stale).toBe(true);
    const row = await prisma.billingSubscription.findFirstOrThrow({ where: { subscriptionRef: `${tag}-sub` } });
    expect(row.businessId).toBe(biz);
  });
});
