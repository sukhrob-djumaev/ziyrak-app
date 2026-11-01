import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/** L5.1 - the owner's billing status: sellable synced versions, the live subscription, and the hold. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { getBillingStatus } from "@/lib/billing/status-view";

const tag = `bs-${Date.now()}`;
let biz: string, other: string, synced: string, unsynced: string;

async function version(key: string, sync: boolean, over: Record<string, unknown> = {}) {
  const item = await prisma.catalogItem.create({ data: { key: `${tag}-${key}`, kind: "addon" } });
  const v = await prisma.catalogVersion.create({
    data: { itemId: item.id, version: 1, state: "published", name: key, grants: [{ capability: "channel.webchat" }], priceMinor: 5000, currency: "MYR", interval: "month", publishedAt: new Date(), ...over },
  });
  if (sync) await prisma.providerPriceRef.create({ data: { versionId: v.id, provider: "stripe", mode: "test", priceRef: `${tag}-${key}-p`, state: "synced" } });
  return v.id;
}
const sub = (businessId: string, status: string, ref: string) =>
  prisma.billingSubscription.create({ data: { businessId, provider: "stripe", subscriptionRef: `${tag}-${ref}`, customerRef: `${tag}-cus`, status, currency: "MYR" } });

beforeAll(async () => {
  biz = (await prisma.business.create({ data: { name: tag, slug: tag } })).id;
  other = (await prisma.business.create({ data: { name: `${tag}-o`, slug: `${tag}-o` } })).id;
  synced = await version("synced", true);
  unsynced = await version("unsynced", false);
});
afterAll(async () => {
  await prisma.billingSubscription.deleteMany({ where: { businessId: { in: [biz, other] } } });
  await prisma.providerPriceRef.deleteMany({ where: { versionId: { in: [synced, unsynced] } } });
  await prisma.business.deleteMany({ where: { id: { in: [biz, other] } } });
});

describe("billing status", () => {
  it("offers only published, provider-synced versions, and nothing without a provider", async () => {
    const s = await getBillingStatus(biz, { name: "stripe", mode: "test" });
    const ids = s.sellable.map((v) => v.versionId);
    expect(ids).toContain(synced);
    expect(ids).not.toContain(unsynced);
    expect(s.providerEnabled).toBe(true);
    expect((await getBillingStatus(biz, null)).sellable).toEqual([]);
  });

  it("reports the live subscription and the hold only for this workspace", async () => {
    expect((await getBillingStatus(biz, null)).subscription).toBeNull();
    await sub(other, "ended", "o");
    expect((await getBillingStatus(biz, null)).hold.held).toBe(false);
    await sub(biz, "past_due", "a");
    const live = await getBillingStatus(biz, null);
    expect(live.subscription?.status).toBe("past_due");
    expect(live.hold.held).toBe(false);
    expect((await getBillingStatus(other, null)).hold.held).toBe(true);
    expect((await getBillingStatus(other, null)).hold.retentionEndsAt).toBeInstanceOf(Date);
  });
});
