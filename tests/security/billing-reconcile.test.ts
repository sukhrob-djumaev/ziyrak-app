import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/** L5.2 - the reconcile job repairs missed webhooks and ends an unpaid subscription once its grace has run out. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { reconcileSubscriptions } from "@/lib/billing/reconcile";
import { paymentHold } from "@/lib/billing/payment-hold";
import type { PaymentProvider, ProviderSubscription } from "@/lib/billing/providers/types";

const tag = `brc-${Date.now()}`;
const DAY = 86_400_000;
let late: string, fresh: string, drift: string;
const ref = (b: string) => `${tag}-${b}-sub`;
const remoteStatus = new Map<string, ProviderSubscription["status"]>();

const getSubscription = vi.fn(async (r: string): Promise<ProviderSubscription> => ({
  ref: r, customerRef: `${tag}-cus`, status: remoteStatus.get(r) ?? "active", cancelAtPeriodEnd: false, currentPeriodEnd: new Date(Date.now() + 10 * DAY), currency: "MYR", items: [], metadata: {}, fetchedAt: new Date(),
}));
const cancelSubscription = vi.fn(async () => undefined);
const provider = { name: "stripe", getSubscription, cancelSubscription } as unknown as PaymentProvider;
const deps = { provider, mode: "test" as const };

async function workspace(name: string, data: { status: string; graceEndsAt?: Date; lastFetchedAt: Date }) {
  const b = await prisma.business.create({ data: { name: `${tag}-${name}`, slug: `${tag}-${name}` } });
  await prisma.billingSubscription.create({ data: { businessId: b.id, provider: "stripe", subscriptionRef: ref(name), customerRef: `${tag}-cus`, currency: "MYR", currentPeriodEnd: new Date(Date.now() + DAY), ...data } });
  return b.id;
}

beforeAll(async () => {
  late = await workspace("late", { status: "past_due", graceEndsAt: new Date(Date.now() - DAY), lastFetchedAt: new Date(Date.now() - 2 * DAY) });
  fresh = await workspace("fresh", { status: "active", lastFetchedAt: new Date() });
  drift = await workspace("drift", { status: "active", lastFetchedAt: new Date(Date.now() - 3 * 3_600_000) });
  remoteStatus.set(ref("late"), "past_due");
  remoteStatus.set(ref("drift"), "canceled");
});
afterAll(async () => {
  const ids = [late, fresh, drift];
  await prisma.workspacePurchase.deleteMany({ where: { businessId: { in: ids } } });
  await prisma.billingSubscription.deleteMany({ where: { businessId: { in: ids } } });
  await prisma.billingIncident.deleteMany({ where: { businessId: { in: ids } } });
  await prisma.business.deleteMany({ where: { id: { in: ids } } });
});

describe("reconcile", () => {
  it("ends an unpaid subscription past its grace, cancels it at the provider and puts the workspace on hold", async () => {
    await reconcileSubscriptions(deps);
    expect((await prisma.billingSubscription.findFirstOrThrow({ where: { businessId: late } })).status).toBe("ended");
    expect(cancelSubscription).toHaveBeenCalledWith({ ref: ref("late"), at: "now" }, expect.any(String));
    expect((await paymentHold(late)).held).toBe(true);
  });

  it("repairs a stale row from the provider's answer", async () => {
    expect((await prisma.billingSubscription.findFirstOrThrow({ where: { businessId: drift } })).status).toBe("ended");
  });

  it("leaves a recently confirmed subscription alone", async () => {
    expect(getSubscription).not.toHaveBeenCalledWith(ref("fresh"));
    expect((await prisma.billingSubscription.findFirstOrThrow({ where: { businessId: fresh } })).status).toBe("active");
  });

  it("is idempotent", async () => {
    const calls = getSubscription.mock.calls.length;
    await reconcileSubscriptions(deps);
    expect(getSubscription.mock.calls.length).toBe(calls);
  });
});
