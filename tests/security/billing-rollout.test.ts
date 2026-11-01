import { describe, it, expect, afterAll, vi } from "vitest";

/** L5 rollout (B10): a workspace that never paid keeps exactly today's access once the payment lifecycle is deployed. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { isEntitled } from "@/lib/billing/entitlements";
import { paymentHold } from "@/lib/billing/payment-hold";

const tag = `br-${Date.now()}`;
let biz = "";

afterAll(async () => {
  if (biz) await prisma.business.deleteMany({ where: { id: biz } });
});

describe("workspace without a subscription", () => {
  it("keeps its baseline access, is never held for payment and has no provider purchase or suspended member", async () => {
    biz = (await prisma.business.create({ data: { name: tag, slug: tag } })).id;
    const purchases = await prisma.workspacePurchase.findMany({ where: { businessId: biz, state: "active" } });
    expect(purchases.map((p) => p.source)).toEqual(["baseline"]);
    expect(await prisma.billingSubscription.count({ where: { businessId: biz } })).toBe(0);
    expect((await paymentHold(biz)).held).toBe(false);
    expect(await isEntitled(biz, "channel.webchat")).toBe(true);
    expect(await prisma.membership.count({ where: { businessId: biz, suspendedByPlanAt: { not: null } } })).toBe(0);
  });
});
