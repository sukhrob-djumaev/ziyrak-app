import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/** L5.2 security-review fixes: stuck events are swept, a second paid subscription is parked, an unpaid row never lifts a hold. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { reconcileSubscriptions } from "@/lib/billing/reconcile";
import { processProviderEvent } from "@/lib/billing/provider-events";
import { paymentHold } from "@/lib/billing/payment-hold";
import type { PaymentProvider, ProviderSubscription } from "@/lib/billing/providers/types";

const tag = `bhd-${Date.now()}`;
const PROV = `stripe-${tag}`;
const DAY = 86_400_000;
let a: string, b: string, c: string;
const failRefs = new Set<string>();

const getSubscription = vi.fn(async (r: string): Promise<ProviderSubscription> => {
  if (failRefs.has(r)) throw new Error("provider down");
  return { ref: r, customerRef: `${tag}-cus`, status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: new Date(Date.now() + 10 * DAY), currency: "MYR", items: [], metadata: {}, fetchedAt: new Date() };
});
const provider = { name: PROV, getSubscription, cancelSubscription: vi.fn() } as unknown as PaymentProvider;
const deps = { provider, mode: "test" as const };
const old = () => new Date(Date.now() - 3_600_000);

async function biz(name: string) {
  return (await prisma.business.create({ data: { name: `${tag}-${name}`, slug: `${tag}-${name}` } })).id;
}
const sub = (businessId: string, name: string, status: string) =>
  prisma.billingSubscription.create({ data: { businessId, provider: PROV, subscriptionRef: `${tag}-${name}`, customerRef: `${tag}-cus`, status, currency: "MYR", lastFetchedAt: new Date() } });

beforeAll(async () => {
  [a, b, c] = [await biz("a"), await biz("b"), await biz("c")];
});
afterAll(async () => {
  const ids = [a, b, c];
  await prisma.providerEvent.deleteMany({ where: { provider: PROV } });
  await prisma.billingIncident.deleteMany({ where: { OR: [{ businessId: { in: ids } }, { detail: { contains: tag } }] } });
  await prisma.workspacePurchase.deleteMany({ where: { businessId: { in: ids } } });
  await prisma.billingOperation.deleteMany({ where: { businessId: { in: ids } } });
  await prisma.billingSubscription.deleteMany({ where: { businessId: { in: ids } } });
  await prisma.business.deleteMany({ where: { id: { in: ids } } });
});

describe("stuck event sweeper", () => {
  it("processes an old unprocessed event and raises an incident when it keeps failing", async () => {
    await sub(a, "a", "incomplete");
    const ok = await prisma.providerEvent.create({ data: { provider: PROV, eventRef: `${tag}-ok`, type: "customer.subscription.updated", payloadHash: "h", subscriptionRef: `${tag}-a`, receivedAt: old() } });
    await reconcileSubscriptions(deps);
    expect((await prisma.providerEvent.findUniqueOrThrow({ where: { id: ok.id } })).state).toBe("processed");
    expect((await prisma.billingSubscription.findFirstOrThrow({ where: { businessId: a } })).status).toBe("active");

    await sub(b, "b", "incomplete");
    failRefs.add(`${tag}-b`);
    const bad = await prisma.providerEvent.create({ data: { provider: PROV, eventRef: `${tag}-bad`, type: "customer.subscription.updated", payloadHash: "h", subscriptionRef: `${tag}-b`, attempts: 7, receivedAt: old() } });
    await reconcileSubscriptions(deps);
    expect((await prisma.providerEvent.findUniqueOrThrow({ where: { id: bad.id } })).state).toBe("failed");
    expect(await prisma.billingIncident.count({ where: { kind: "paid_not_provisioned", state: "open", detail: { contains: `${tag}-bad` } } })).toBe(1);
  });

  it("leaves a recent event to its own job", async () => {
    const fresh = await prisma.providerEvent.create({ data: { provider: PROV, eventRef: `${tag}-fresh`, type: "customer.subscription.updated", payloadHash: "h", subscriptionRef: `${tag}-a` } });
    await reconcileSubscriptions(deps);
    expect((await prisma.providerEvent.findUniqueOrThrow({ where: { id: fresh.id } })).state).toBe("received");
  });
});

describe("second paid subscription", () => {
  it("is parked with an incident instead of retrying forever", async () => {
    // a already has a live (active) subscription from the sweep above; a second one arrives through a stale checkout.
    const op = await prisma.billingOperation.create({ data: { businessId: a, kind: "checkout", idemKey: `${tag}-idem`, quoteHash: "q", requestedBy: "u" } });
    const ev = await prisma.providerEvent.create({ data: { provider: PROV, eventRef: `${tag}-dbl`, type: "checkout.session.completed", payloadHash: "h", subscriptionRef: `${tag}-second`, clientReference: op.id } });
    await expect(processProviderEvent(ev.id, { provider, providerName: PROV, mode: "test" })).resolves.toBe("ignored");
    expect((await prisma.providerEvent.findUniqueOrThrow({ where: { id: ev.id } })).state).toBe("ignored");
    expect(await prisma.billingIncident.count({ where: { businessId: a, kind: "double_paid", state: "open" } })).toBe(1);
    expect(await prisma.billingSubscription.count({ where: { businessId: a, status: { not: "ended" } } })).toBe(1);
  });
});

describe("double-paid review follow-ups", () => {
  it("counts a failure that is not a provider read, and retries while only an incomplete row blocks the index", async () => {
    const d = await biz("e");
    await sub(d, "e-inc", "incomplete");
    const op = await prisma.billingOperation.create({ data: { businessId: d, kind: "checkout", idemKey: `${tag}-idem-e`, quoteHash: "q", requestedBy: "u" } });
    const ev = await prisma.providerEvent.create({ data: { provider: PROV, eventRef: `${tag}-inc`, type: "checkout.session.completed", payloadHash: "h", subscriptionRef: `${tag}-e-paid`, clientReference: op.id, receivedAt: old() } });
    await expect(processProviderEvent(ev.id, { provider, providerName: PROV, mode: "test" })).rejects.toBeTruthy();
    expect((await prisma.providerEvent.findUniqueOrThrow({ where: { id: ev.id } })).state).toBe("received");
    expect(await prisma.billingIncident.count({ where: { businessId: d, kind: "double_paid" } })).toBe(0);
    await reconcileSubscriptions(deps);
    expect((await prisma.providerEvent.findUniqueOrThrow({ where: { id: ev.id } })).attempts).toBeGreaterThan(0);
    await prisma.providerEvent.deleteMany({ where: { id: ev.id } });
    await prisma.billingOperation.deleteMany({ where: { businessId: d } });
    await prisma.billingSubscription.deleteMany({ where: { businessId: d } });
    await prisma.business.delete({ where: { id: d } });
  });
});

describe("payment hold and unpaid rows", () => {
  it("stays held when the only newer row is an unpaid incomplete one, and a first checkout is not held", async () => {
    await sub(c, "c-old", "ended");
    await sub(c, "c-new", "incomplete");
    const held = await paymentHold(c);
    expect(held.held).toBe(true);
    // The retention clock follows the ended row, not an incomplete row that reconcile keeps rewriting.
    const endedAt = (await prisma.billingSubscription.findFirstOrThrow({ where: { businessId: c, status: "ended" } })).updatedAt;
    expect(held.since?.getTime()).toBe(endedAt.getTime());
    await prisma.billingSubscription.updateMany({ where: { businessId: c, subscriptionRef: `${tag}-c-new` }, data: { status: "active" } });
    expect((await paymentHold(c)).held).toBe(false);

    const fresh = await biz("d");
    await sub(fresh, "d", "incomplete");
    expect((await paymentHold(fresh)).held).toBe(false);
    await prisma.billingSubscription.deleteMany({ where: { businessId: fresh } });
    await prisma.business.delete({ where: { id: fresh } });
  });
});
