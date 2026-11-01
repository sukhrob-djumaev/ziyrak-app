import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/** L5.2 - immediate upgrades (add an add-on, raise a quantity): server-priced, quote bound to the subscription rev, applied only from the provider's answer. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { quoteUpgrade, startUpgrade } from "@/lib/billing/changes";
import { ProviderError } from "@/lib/billing/providers/types";
import type { PaymentProvider, ProviderSubscription } from "@/lib/billing/providers/types";

const tag = `bu-${Date.now()}`;
let biz: string, other: string, subId: string;
const v = { bundle: "", seat: "", report: "", usd: "", unsynced: "" };

const snapshot = (items: { itemRef: string; priceRef: string; quantity: number }[]): ProviderSubscription => ({
  ref: `${tag}-sub`, customerRef: `${tag}-cus`, status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  currency: "MYR", items, metadata: {}, fetchedAt: new Date(),
});
const base = [
  { itemRef: "si_b", priceRef: `${tag}-bundle-p`, quantity: 1 },
  { itemRef: "si_s", priceRef: `${tag}-seat-p`, quantity: 2 },
];
const getSubscription = vi.fn(async () => snapshot(base));
const changeSubscription = vi.fn(async (i: { lines: { priceRef: string; quantity: number; itemRef?: string }[] }) =>
  snapshot([...base.filter((b) => !i.lines.some((l) => l.priceRef === b.priceRef)), ...i.lines.map((l) => ({ itemRef: l.itemRef ?? "si_new", priceRef: l.priceRef, quantity: l.quantity }))]),
);
const provider = { name: "stripe", getSubscription, changeSubscription } as unknown as PaymentProvider;
const deps = { provider, mode: "test" as const };

async function version(key: string, kind: string, over: Record<string, unknown> = {}, synced = true) {
  const item = await prisma.catalogItem.create({ data: { key: `${tag}-${key}`, kind } });
  const row = await prisma.catalogVersion.create({
    data: { itemId: item.id, version: 1, state: "published", name: key, grants: [{ capability: "channel.webchat" }], priceMinor: 5000, currency: "MYR", interval: "month", publishedAt: new Date(), ...over },
  });
  if (synced) await prisma.providerPriceRef.create({ data: { versionId: row.id, provider: "stripe", mode: "test", priceRef: `${tag}-${key}-p`, state: "synced" } });
  return row.id;
}

beforeAll(async () => {
  biz = (await prisma.business.create({ data: { name: tag, slug: tag } })).id;
  other = (await prisma.business.create({ data: { name: `${tag}-o`, slug: `${tag}-o` } })).id;
  v.bundle = await version("bundle", "bundle", { priceMinor: 19900 });
  v.seat = await version("seat", "addon");
  v.report = await version("report", "addon", { priceMinor: 3000 });
  v.usd = await version("usd", "addon", { currency: "USD" });
  v.unsynced = await version("unsynced", "addon", {}, false);
  const sub = await prisma.billingSubscription.create({ data: { businessId: biz, provider: "stripe", subscriptionRef: `${tag}-sub`, customerRef: `${tag}-cus`, status: "active", currency: "MYR" } });
  subId = sub.id;
  await prisma.billingSubscriptionItem.create({ data: { subscriptionId: subId, versionId: v.bundle, quantity: 1 } });
  await prisma.billingSubscriptionItem.create({ data: { subscriptionId: subId, versionId: v.seat, quantity: 2 } });
});
afterAll(async () => {
  await prisma.workspacePurchase.deleteMany({ where: { businessId: { in: [biz, other] } } });
  await prisma.billingSubscription.deleteMany({ where: { businessId: { in: [biz, other] } } });
  await prisma.billingOperation.deleteMany({ where: { businessId: { in: [biz, other] } } });
  await prisma.providerPriceRef.deleteMany({ where: { versionId: { in: Object.values(v) } } });
  await prisma.business.deleteMany({ where: { id: { in: [biz, other] } } });
});

const fresh = async (lines: { versionId: string; quantity: number }[]) => {
  const q = await quoteUpgrade(biz, { lines }, deps);
  return { lines, quoteHash: q.quoteHash, quotedAt: q.quotedAt };
};

describe("upgrade quote", () => {
  it("prices only the increase: a new add-on in full, a raised quantity by the difference", async () => {
    const q = await quoteUpgrade(biz, { lines: [{ versionId: v.report, quantity: 1 }, { versionId: v.seat, quantity: 5 }] }, deps);
    expect(q.totalMinor).toBe(3000 + 3 * 5000);
    expect(q.lines.map((l) => [l.versionId, l.quantity]).sort()).toEqual([[v.report, 1], [v.seat, 3]].sort());
  });

  it("refuses a decrease, a bundle, a wrong currency, an unsynced version and a workspace with no subscription", async () => {
    const q = (lines: unknown[], b = biz) => quoteUpgrade(b, { lines }, deps);
    await expect(q([{ versionId: v.seat, quantity: 2 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(q([{ versionId: v.seat, quantity: 1 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(q([{ versionId: v.bundle, quantity: 2 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(q([{ versionId: v.usd, quantity: 1 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(q([{ versionId: v.unsynced, quantity: 1 }])).rejects.toMatchObject({ statusCode: 409 });
    await expect(q([{ versionId: v.report, quantity: 1 }], other)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("start upgrade", () => {
  it("sends the provider the item refs it just read, grants only from the answer, and records the operation", async () => {
    const input = await fresh([{ versionId: v.seat, quantity: 4 }]);
    const out = await startUpgrade({ businessId: biz, userId: "u1" }, input, deps);
    expect(out.status).toBe("active");
    const sent = changeSubscription.mock.calls[0][0] as { lines: { priceRef: string; quantity: number; itemRef?: string }[] };
    expect(sent.lines).toEqual([{ priceRef: `${tag}-seat-p`, quantity: 4, itemRef: "si_s" }]);
    const seat = await prisma.billingSubscriptionItem.findFirstOrThrow({ where: { subscriptionId: subId, versionId: v.seat } });
    expect(seat.quantity).toBe(4);
    const purchase = await prisma.workspacePurchase.findFirst({ where: { businessId: biz, subscriptionItemId: seat.id, state: "active" } });
    expect(purchase?.quantity).toBe(4);
    const op = await prisma.billingOperation.findFirstOrThrow({ where: { businessId: biz, kind: "change" } });
    expect(op.state).toBe("succeeded");
  });

  it("an unpaid upgrade (provider leaves the old quantity) grants nothing and marks the operation pending", async () => {
    changeSubscription.mockImplementationOnce(async () => snapshot(base.map((b) => ({ ...b }))));
    const input = await fresh([{ versionId: v.report, quantity: 1 }]);
    const out = await startUpgrade({ businessId: biz, userId: "u1" }, input, deps);
    expect(out.confirmed).toBe(false);
    expect(await prisma.billingSubscriptionItem.count({ where: { subscriptionId: subId, versionId: v.report } })).toBe(0);
  });

  it("a stale quote (subscription moved since) is refused before any provider call", async () => {
    const input = await fresh([{ versionId: v.report, quantity: 2 }]);
    await prisma.billingSubscription.update({ where: { id: subId }, data: { rev: { increment: 1 } } });
    changeSubscription.mockClear();
    await expect(startUpgrade({ businessId: biz, userId: "u1" }, input, deps)).rejects.toMatchObject({ code: "QUOTE_STALE" });
    expect(changeSubscription).not.toHaveBeenCalled();
  });

  it("another workspace cannot use this workspace's quote", async () => {
    const input = await fresh([{ versionId: v.report, quantity: 3 }]);
    await expect(startUpgrade({ businessId: other, userId: "u1" }, input, deps)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("a provider rejection marks the operation failed, so it does not block the next change; an outage leaves it unknown", async () => {
    await prisma.billingOperation.deleteMany({ where: { businessId: biz, kind: "change" } });
    changeSubscription.mockRejectedValueOnce(new ProviderError("rejected", "card declined", 402));
    const input = await fresh([{ versionId: v.report, quantity: 1 }]);
    await expect(startUpgrade({ businessId: biz, userId: "u1" }, input, deps)).rejects.toBeInstanceOf(ProviderError);
    expect((await prisma.billingOperation.findFirstOrThrow({ where: { businessId: biz, kind: "change" } })).state).toBe("failed");
    await prisma.billingOperation.deleteMany({ where: { businessId: biz, kind: "change" } });
    changeSubscription.mockRejectedValueOnce(new ProviderError("unknown", "timeout"));
    await expect(startUpgrade({ businessId: biz, userId: "u1" }, await fresh([{ versionId: v.report, quantity: 1 }]), deps)).rejects.toBeInstanceOf(ProviderError);
    expect((await prisma.billingOperation.findFirstOrThrow({ where: { businessId: biz, kind: "change" } })).state).toBe("unknown");
  });

  it("an unknown operation blocks a change while recent but not once it is stale", async () => {
    const input = await fresh([{ versionId: v.report, quantity: 1 }]);
    await expect(startUpgrade({ businessId: biz, userId: "u1" }, input, deps)).rejects.toMatchObject({ statusCode: 409 });
    await prisma.billingOperation.updateMany({ where: { businessId: biz, kind: "change" }, data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) } });
    const out = await startUpgrade({ businessId: biz, userId: "u1" }, await fresh([{ versionId: v.report, quantity: 1 }]), deps);
    expect(out.confirmed).toBe(true);
  });
});

describe("concurrent upgrades", () => {
  it("two changes quoted from the same subscription state: one wins, the other is told to re-quote and reaches no provider", async () => {
    await prisma.billingOperation.deleteMany({ where: { businessId: biz } });
    const a = await fresh([{ versionId: v.seat, quantity: 7 }]);
    const b = await fresh([{ versionId: v.report, quantity: 2 }]);
    const calls = changeSubscription.mock.calls.length;
    const results = await Promise.allSettled([startUpgrade({ businessId: biz, userId: "u1" }, a, deps), startUpgrade({ businessId: biz, userId: "u2" }, b, deps)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ statusCode: 409 });
    expect(changeSubscription.mock.calls.length - calls).toBe(1);
  });
});
