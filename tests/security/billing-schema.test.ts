import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/** L5.1 - payment-lifecycle tables: one live subscription per workspace, unique provider refs, status check. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";

let businessA: string;
let businessB: string;
const tag = `bs-${Date.now()}`;
const sub = (businessId: string, ref: string, status: string) => ({
  businessId,
  provider: "stripe",
  subscriptionRef: `${tag}-${ref}`,
  customerRef: `${tag}-cus`,
  status,
  currency: "MYR",
});

beforeAll(async () => {
  businessA = (await prisma.business.create({ data: { name: `${tag}-a`, slug: `${tag}-a` } })).id;
  businessB = (await prisma.business.create({ data: { name: `${tag}-b`, slug: `${tag}-b` } })).id;
});

afterAll(async () => {
  await prisma.billingSubscription.deleteMany({ where: { businessId: { in: [businessA, businessB] } } });
  await prisma.providerEvent.deleteMany({ where: { provider: tag } });
  await prisma.business.deleteMany({ where: { id: { in: [businessA, businessB] } } });
});

describe("billing schema constraints", () => {
  it("allows only one non-ended subscription per workspace, but any number of ended ones", async () => {
    await prisma.billingSubscription.create({ data: sub(businessA, "s1", "ended") });
    await prisma.billingSubscription.create({ data: sub(businessA, "s2", "ended") });
    await prisma.billingSubscription.create({ data: sub(businessA, "s3", "active") });
    await expect(prisma.billingSubscription.create({ data: sub(businessA, "s4", "past_due") })).rejects.toThrow();
    await prisma.billingSubscription.create({ data: sub(businessB, "s5", "active") });
  });

  it("rejects an unknown subscription status", async () => {
    await expect(prisma.billingSubscription.create({ data: sub(businessB, "s6", "paused") })).rejects.toThrow();
  });

  it("rejects a duplicate provider subscription ref and a duplicate provider event", async () => {
    await expect(prisma.billingSubscription.create({ data: sub(businessB, "s5", "ended") })).rejects.toThrow();
    const e = { provider: tag, eventRef: "evt_1", type: "x", payloadHash: "h" };
    await prisma.providerEvent.create({ data: e });
    await expect(prisma.providerEvent.create({ data: e })).rejects.toThrow();
  });
});
