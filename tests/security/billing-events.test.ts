import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/** L5.1 - webhook inbox: dedupe, binding via our own rows, authoritative re-read, ignored noise. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { recordProviderEvent, processProviderEvent } from "@/lib/billing/provider-events";
import type { PaymentProvider, ProviderSubscription } from "@/lib/billing/providers/types";

const tag = `be-${Date.now()}`;
let biz: string, versionId: string, itemId: string, opId: string;
const subRef = `${tag}-sub`;
const snap = (over: Partial<ProviderSubscription> = {}): ProviderSubscription => ({
  ref: subRef, customerRef: `${tag}-cus`, status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000), currency: "MYR",
  items: [{ itemRef: "si", priceRef: `${tag}-price`, quantity: 1 }], metadata: {}, fetchedAt: new Date(), ...over,
});
const fake = (s: ProviderSubscription | Error): PaymentProvider => ({ getSubscription: async () => { if (s instanceof Error) throw s; return s; } } as unknown as PaymentProvider);
const deps = (p: PaymentProvider) => ({ provider: p, providerName: "stripe", mode: "test" as const });
const ev = (n: string, over = {}) => ({ eventRef: `${tag}-${n}`, type: "customer.subscription.updated", subscriptionRef: subRef, customerRef: `${tag}-cus`, clientReference: null, ...over });
const body = Buffer.from("{}");

beforeAll(async () => {
  biz = (await prisma.business.create({ data: { name: tag, slug: tag } })).id;
  itemId = (await prisma.catalogItem.create({ data: { key: `${tag}-b`, kind: "bundle" } })).id;
  versionId = (await prisma.catalogVersion.create({ data: { itemId, version: 1, state: "published", name: "T", grants: [{ capability: "channel.webchat" }], priceMinor: 100, currency: "MYR", interval: "month", publishedAt: new Date() } })).id;
  await prisma.providerPriceRef.create({ data: { versionId, provider: "stripe", mode: "test", priceRef: `${tag}-price`, state: "synced" } });
  await prisma.billingCustomer.create({ data: { businessId: biz, provider: "stripe", customerRef: `${tag}-cus` } });
  opId = (await prisma.billingOperation.create({ data: { businessId: biz, kind: "checkout", idemKey: `${tag}-idem`, quoteHash: "h", requestedBy: "u" } })).id;
});
afterAll(async () => {
  await prisma.workspacePurchase.deleteMany({ where: { businessId: biz } });
  await prisma.billingIncident.deleteMany({ where: { OR: [{ businessId: biz }, { detail: { contains: tag } }] } });
  await prisma.billingSubscription.deleteMany({ where: { businessId: biz } });
  await prisma.billingOperation.deleteMany({ where: { businessId: biz } });
  await prisma.billingCustomer.deleteMany({ where: { businessId: biz } });
  await prisma.providerEvent.deleteMany({ where: { eventRef: { startsWith: tag } } });
  await prisma.providerPriceRef.deleteMany({ where: { versionId } });
  await prisma.business.deleteMany({ where: { id: biz } });
});

describe("provider event inbox", () => {
  it("records an event once", async () => {
    const a = await recordProviderEvent("stripe", ev("dup"), body);
    const b = await recordProviderEvent("stripe", ev("dup"), body);
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
  });

  it("an unbound checkout event binds through our operation row and grants access", async () => {
    const r = await recordProviderEvent("stripe", ev("co", { type: "checkout.session.completed", clientReference: opId }), body);
    expect(await processProviderEvent(r.id, deps(fake(snap())))).toBe("processed");
    expect(await prisma.workspacePurchase.count({ where: { businessId: biz, source: "provider", state: "active" } })).toBe(1);
    expect((await prisma.billingOperation.findUniqueOrThrow({ where: { id: opId } })).state).toBe("succeeded");
  });

  it("an event for an unknown subscription is ignored with an incident, never applied", async () => {
    const r = await recordProviderEvent("stripe", ev("unk", { subscriptionRef: `${tag}-other`, customerRef: `${tag}-nobody` }), body);
    expect(await processProviderEvent(r.id, deps(fake(snap())))).toBe("ignored");
    expect(await prisma.billingIncident.count({ where: { businessId: null, kind: "unbound_ref", detail: { contains: `${tag}-unk` } } })).toBe(1);
  });

  it("an unhandled event type is ignored", async () => {
    const r = await recordProviderEvent("stripe", ev("odd", { type: "charge.refunded" }), body);
    expect(await processProviderEvent(r.id, deps(fake(snap())))).toBe("ignored");
  });

  it("a provider read failure keeps the event retryable", async () => {
    const r = await recordProviderEvent("stripe", ev("fail"), body);
    await expect(processProviderEvent(r.id, deps(fake(new Error("boom"))))).rejects.toThrow("boom");
    expect((await prisma.providerEvent.findUniqueOrThrow({ where: { id: r.id } })).state).toBe("received");
    expect(await processProviderEvent(r.id, deps(fake(snap({ fetchedAt: new Date() }))))).toBe("processed");
  });

  it("a subscription whose customer is not ours is not applied", async () => {
    const r = await recordProviderEvent("stripe", ev("cus"), body);
    expect(await processProviderEvent(r.id, deps(fake(snap({ customerRef: "cus_evil", fetchedAt: new Date() }))))).toBe("ignored");
  });
});
