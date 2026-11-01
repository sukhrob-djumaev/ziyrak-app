import { describe, it, expect, afterAll, vi } from "vitest";

/** L5.3 - concurrent webhook delivery: the inbox keeps one row and only one caller is told it is new. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { recordProviderEvent } from "@/lib/billing/provider-events";

const tag = `bc-${Date.now()}`;
const ev = { eventRef: `${tag}-evt`, type: "customer.subscription.updated", subscriptionRef: `${tag}-sub`, customerRef: `${tag}-cus`, clientReference: null };
const body = Buffer.from("{}");

afterAll(async () => {
  await prisma.providerEvent.deleteMany({ where: { eventRef: { startsWith: tag } } });
});

describe("concurrent webhook delivery", () => {
  it("twelve simultaneous deliveries of one event store one row and report one creation", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => recordProviderEvent("stripe", ev, body)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await prisma.providerEvent.count({ where: { eventRef: ev.eventRef } })).toBe(1);
  });
});
