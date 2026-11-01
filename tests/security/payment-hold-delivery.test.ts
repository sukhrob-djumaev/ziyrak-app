import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/** L5.1 - a paused workspace sends nothing, including deliveries queued before the hold; they stay ready until payment resumes. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { dispatchDelivery } from "@/lib/conversations/delivery";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let biz: SeededBusiness;
let deliveryId = "";

beforeAll(async () => {
  biz = await seedBusiness("hold-delivery");
  deliveryId = (
    await prisma.deliveryOperation.create({
      data: { businessId: biz.businessId, operationKey: `hold-${Date.now()}`, kind: "followup", channel: "webchat", connectionId: "c", recipient: "r", response: "hello", status: "ready" },
    })
  ).id;
  await prisma.billingSubscription.create({
    data: { businessId: biz.businessId, provider: "stripe", subscriptionRef: `hold-${Date.now()}`, customerRef: "cus", status: "ended", currency: "MYR" },
  });
});
afterAll(async () => {
  if (biz) {
    await prisma.billingSubscription.deleteMany({ where: { businessId: biz.businessId } });
    await cleanupBusiness(biz.businessId);
  }
});

describe("delivery during a payment hold", () => {
  it("is refused before anything is claimed or sent", async () => {
    await expect(dispatchDelivery(biz.ctx, deliveryId)).rejects.toMatchObject({ statusCode: 402, code: "PAYMENT_HOLD" });
    expect((await prisma.deliveryOperation.findUniqueOrThrow({ where: { id: deliveryId } })).status).toBe("ready");
  });
});
