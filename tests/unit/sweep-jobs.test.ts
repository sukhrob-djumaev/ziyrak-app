import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/**
 * PLAN.md §25.2/§33.2/§46.6 PR2 task 12 — "A test seeding a breached SLA
 * rule for one business and an unbreached one for another, running the
 * sweep, and confirming only the breached business's conversation is
 * escalated (tenant-isolation check applied to job-based sweeps
 * specifically)." Real Postgres — these sweeps' whole point is real
 * cross-business iteration via the control-plane Business table.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma as rawClient } from "@/lib/prisma/raw-client";
import { runSlaBreachSweep } from "@/lib/jobs/handlers/sweep-sla-breaches";
import { runRetentionSweep } from "@/lib/jobs/handlers/sweep-retention";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let breachedBusiness: SeededBusiness;
let quietBusiness: SeededBusiness;

beforeAll(async () => {
  breachedBusiness = await seedBusiness("sweep-breached");
  quietBusiness = await seedBusiness("sweep-quiet");
});

afterAll(async () => {
  await cleanupBusiness(breachedBusiness.businessId);
  await cleanupBusiness(quietBusiness.businessId);
});

describe("sweep-sla-breaches (§25.2/§33.2/§46.6)", () => {
  it("escalates only the breached business's stale conversation, leaving the other business untouched", async () => {
    const staleCreatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago

    await rawClient.sLARule.create({
      data: { businessId: breachedBusiness.businessId, name: "Fast response", firstResponseMins: 30, isActive: true },
    });
    const breachedConversation = await rawClient.conversation.create({
      data: {
        businessId: breachedBusiness.businessId,
        channel: "sms",
        customerName: "Breached Customer",
        status: "active",
        createdAt: staleCreatedAt,
      },
    });

    // Second business: an SLA rule exists, but its only conversation is fresh — must not be touched.
    await rawClient.sLARule.create({
      data: { businessId: quietBusiness.businessId, name: "Fast response", firstResponseMins: 30, isActive: true },
    });
    const freshConversation = await rawClient.conversation.create({
      data: { businessId: quietBusiness.businessId, channel: "sms", customerName: "Fresh Customer", status: "active" },
    });

    await runSlaBreachSweep();

    const breachedAfter = await rawClient.conversation.findUnique({ where: { id: breachedConversation.id } });
    const freshAfter = await rawClient.conversation.findUnique({ where: { id: freshConversation.id } });

    expect(breachedAfter?.status).toBe("escalated");
    expect(freshAfter?.status).toBe("active"); // untouched — proves tenant isolation, not just "the sweep ran"
  });
});

describe("sweep-retention (§25.2/§46.6)", () => {
  it("only purges data for the business that configured a retentionDays policy", async () => {
    const staleUpdatedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000); // ~13 months ago

    await rawClient.businessConfig.upsert({
      where: { businessId: breachedBusiness.businessId },
      update: { retentionDays: 30 },
      create: { businessId: breachedBusiness.businessId, retentionDays: 30 },
    });
    // quietBusiness deliberately has no BusinessConfig.retentionDays set (null) — the sweep must skip it.

    const oldConversation = await rawClient.conversation.create({
      data: {
        businessId: breachedBusiness.businessId,
        channel: "sms",
        customerName: "Old Resolved",
        status: "resolved",
        updatedAt: staleUpdatedAt,
      },
    });
    const oldConversationOtherBusiness = await rawClient.conversation.create({
      data: {
        businessId: quietBusiness.businessId,
        channel: "sms",
        customerName: "Old Resolved No Policy",
        status: "resolved",
        updatedAt: staleUpdatedAt,
      },
    });

    await runRetentionSweep();

    const deleted = await rawClient.conversation.findUnique({ where: { id: oldConversation.id } });
    const kept = await rawClient.conversation.findUnique({ where: { id: oldConversationOtherBusiness.id } });

    expect(deleted).toBeNull(); // purged — retentionDays: 30 configured, well past cutoff
    expect(kept).not.toBeNull(); // kept — no retention policy configured for this business
  });
});
