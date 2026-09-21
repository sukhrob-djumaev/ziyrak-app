import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/**
 * PLAN.md §25.2/§46.6 PR3 task 15's own "Tests first" requirement: "A test
 * for execute-campaign confirming partial failure (one customer's send
 * fails) does not prevent the remaining customers from being processed,
 * and that failure is recorded per-customer, not just aggregated."
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma as rawClient } from "@/lib/prisma/raw-client";
import { handleExecuteCampaign } from "@/lib/jobs/handlers/execute-campaign";
import { registerChannelAdapter } from "@/lib/channels/registry";
import type { ChannelAdapter } from "@/lib/channels/types";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import type { TenantContext } from "@/lib/tenancy/context";

const TEST_CHANNEL = "test-campaign-channel";

let business: SeededBusiness;
let attemptedContacts: string[];
let failingPhone: string;

beforeAll(async () => {
  business = await seedBusiness("execute-campaign");

  const fakeAdapter: ChannelAdapter = {
    type: TEST_CHANNEL,
    capabilities: { supportsMedia: false, supportsTemplates: false, supportsTypingIndicator: false, supportsDeliveryReceipts: false, supportsMultipleConnections: false },
    async validateInbound() {
      return { kind: "rejected", reason: "not used in this test" };
    },
    async sendMessage(_ctx, _connectionId, to) {
      attemptedContacts.push(to);
      if (to === failingPhone) return { success: false, error: "simulated delivery failure" };
      return { success: true };
    },
    async getStatus() {
      return { connected: true };
    },
  };
  registerChannelAdapter(TEST_CHANNEL, fakeAdapter);

  await rawClient.channelConnection.create({
    data: { businessId: business.businessId, type: TEST_CHANNEL, name: "campaign-conn", isActive: true },
  });
});

afterAll(async () => {
  await cleanupBusiness(business.businessId);
});

function ctx(): TenantContext {
  return {
    businessId: business.businessId,
    role: null,
    actor: { kind: "system_job", jobId: "test-execute-campaign", jobType: "execute-campaign" },
    dataConnection: "shared-default",
  };
}

describe("execute-campaign — partial failure does not stop the remaining sends (§25.2/§46.6 PR3)", () => {
  it("sends to every matched customer independently; one failure doesn't block the others, and success is tracked per-customer", async () => {
    attemptedContacts = [];
    failingPhone = "+15550000001";

    const customerA = await rawClient.customer.create({ data: { businessId: business.businessId, name: "A", phone: failingPhone } });
    const customerB = await rawClient.customer.create({ data: { businessId: business.businessId, name: "B", phone: "+15550000002" } });
    const customerC = await rawClient.customer.create({ data: { businessId: business.businessId, name: "C", phone: "+15550000003" } });

    const campaign = await rawClient.campaign.create({
      data: { businessId: business.businessId, name: "Test Campaign", channel: TEST_CHANNEL, message: "Special offer!", segments: [] },
    });

    await handleExecuteCampaign(ctx(), { businessId: business.businessId, campaignId: campaign.id });

    // All three were attempted — the failure on A did not stop B/C.
    expect(attemptedContacts.sort()).toEqual([customerA.phone, customerB.phone, customerC.phone].sort());

    const finalCampaign = await rawClient.campaign.findUnique({ where: { id: campaign.id } });
    expect(finalCampaign?.status).toBe("completed");
    // Only the two successful sends are counted — the failure is not silently folded into a success count.
    expect(finalCampaign?.sentCount).toBe(2);

    // Per-customer result tracking: a real Conversation+Message exists for
    // each successful send, and none exists for the customer whose send failed.
    const conversationA = await rawClient.conversation.findFirst({ where: { customerId: customerA.id } });
    const conversationB = await rawClient.conversation.findFirst({ where: { customerId: customerB.id } });
    const conversationC = await rawClient.conversation.findFirst({ where: { customerId: customerC.id } });
    expect(conversationA).toBeNull();
    expect(conversationB).not.toBeNull();
    expect(conversationC).not.toBeNull();
  });

  it("pauses the campaign honestly when no active connection exists for its channel, rather than claiming completion", async () => {
    const campaign = await rawClient.campaign.create({
      data: { businessId: business.businessId, name: "No Connection Campaign", channel: "channel-with-no-connection", message: "hi", segments: [] },
    });

    await handleExecuteCampaign(ctx(), { businessId: business.businessId, campaignId: campaign.id });

    const finalCampaign = await rawClient.campaign.findUnique({ where: { id: campaign.id } });
    expect(finalCampaign?.status).toBe("paused");
    expect(finalCampaign?.sentCount).toBe(0);
  });
});
