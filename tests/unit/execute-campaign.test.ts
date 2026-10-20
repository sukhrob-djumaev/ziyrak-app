import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/**
 * PLAN.md §25.2/§46.6 PR3 task 15's own "Tests first" requirement: "A test for execute-campaign
 * confirming partial failure (one customer's send fails) does not prevent the remaining
 * customers from being processed, and that failure is recorded per-customer, not just
 * aggregated." Now expressed through the frozen campaign run and per-recipient operations.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma as rawClient } from "@/lib/prisma/raw-client";
import { handleExecuteCampaign } from "@/lib/jobs/handlers/execute-campaign";
import { startCampaignRun } from "@/lib/campaigns/campaign-run";
import { jobQueue } from "@/lib/jobs/queue";
import { registerChannelAdapter } from "@/lib/channels/registry";
import type { ChannelAdapter } from "@/lib/channels/types";
import {
  seedBusiness,
  addMember,
  cleanupBusiness,
  type SeededBusiness,
} from "../helpers/tenant-fixtures";
import type { TenantContext } from "@/lib/tenancy/context";

const TEST_CHANNEL = "test-campaign-channel";

let business: SeededBusiness;
let requester: Awaited<ReturnType<typeof addMember>>;
let attemptedContacts: string[];
let failingPhone: string;

beforeAll(async () => {
  business = await seedBusiness("execute-campaign");
  requester = await addMember(business.businessId, "admin", "campaign-runner");

  const fakeAdapter: ChannelAdapter = {
    type: TEST_CHANNEL,
    capabilities: {
      supportsMedia: false,
      supportsTemplates: false,
      supportsTypingIndicator: false,
      supportsDeliveryReceipts: false,
      supportsMultipleConnections: false,
    },
    async validateInbound() {
      return { kind: "rejected", reason: "not used in this test" };
    },
    async sendMessage(_ctx, _connectionId, to) {
      attemptedContacts.push(to);
      if (to === failingPhone)
        return { success: false, outcome: "rejected", error: "simulated delivery failure" };
      return { success: true };
    },
    async getStatus() {
      return { connected: true };
    },
  };
  registerChannelAdapter(TEST_CHANNEL, fakeAdapter);

  await rawClient.channelConnection.create({
    data: {
      businessId: business.businessId,
      type: TEST_CHANNEL,
      name: "campaign-conn",
      isActive: true,
    },
  });
});

afterAll(async () => {
  await cleanupBusiness(business.businessId);
});

function worker(): TenantContext {
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
    const enqueue = vi.spyOn(jobQueue, "enqueue").mockResolvedValue("paused-fixture");

    const customerA = await rawClient.customer.create({
      data: { businessId: business.businessId, name: "A", phone: failingPhone },
    });
    const customerB = await rawClient.customer.create({
      data: { businessId: business.businessId, name: "B", phone: "+15550000002" },
    });
    const customerC = await rawClient.customer.create({
      data: { businessId: business.businessId, name: "C", phone: "+15550000003" },
    });
    const campaign = await rawClient.campaign.create({
      data: {
        businessId: business.businessId,
        name: "Test Campaign",
        channel: TEST_CHANNEL,
        message: "Special offer!",
        segments: [],
      },
    });

    const { runId } = await startCampaignRun(requester.ctx, campaign.id);
    await handleExecuteCampaign(worker(), { businessId: business.businessId, runId });
    enqueue.mockRestore();

    // All three were attempted — the failure on A did not stop B/C.
    expect(attemptedContacts.sort()).toEqual(
      [customerA.phone, customerB.phone, customerC.phone].sort()
    );
    const finalCampaign = await rawClient.campaign.findUnique({ where: { id: campaign.id } });
    expect(finalCampaign?.status).toBe("completed");
    // Only the two accepted sends are counted — the refusal is not folded into a success count.
    expect(finalCampaign?.sentCount).toBe(2);

    // Per-customer result tracking on durable operations.
    const operations = await rawClient.deliveryOperation.findMany({
      where: { businessId: business.businessId, campaignRunId: runId },
    });
    const byKey = new Map(operations.map((op) => [op.operationKey, op.status]));
    expect(byKey.get(`campaign:${runId}:${customerA.id}`)).toBe("rejected");
    expect(byKey.get(`campaign:${runId}:${customerB.id}`)).toBe("accepted");
    expect(byKey.get(`campaign:${runId}:${customerC.id}`)).toBe("accepted");
    const sentMessages = await rawClient.message.findMany({
      where: { businessId: business.businessId, role: "assistant", content: "Special offer!" },
    });
    expect(sentMessages).toHaveLength(2);
  });
});
