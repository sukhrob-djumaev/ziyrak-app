import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/**
 * PLAN.md §34.3 item 4/§44.2/§46.6 task 6 — "automation configured →
 * relevant event occurs → actual runtime action executes." Before this
 * phase this test could not be written honestly (§2.4 — evaluateRules()
 * had zero runtime callers). Real Postgres, a synthetic ZiyrakEvent run
 * through the real processInboundMessage() (§34.3 item 3's own pattern),
 * no AI provider configured — deliberately, so an auto_reply's success
 * proves the short-circuit never needed the model at all.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma as rawClient } from "@/lib/prisma/raw-client";
import { processInboundMessage } from "@/lib/conversations/inbound";
import { buildMessageReceivedEvent } from "@/lib/events/types";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import type { TenantContext } from "@/lib/tenancy/context";

let business: SeededBusiness;
let ctx: TenantContext;

beforeAll(async () => {
  business = await seedBusiness("automation-reconnect");
  ctx = {
    businessId: business.businessId,
    role: null,
    actor: { kind: "system_job", jobId: "test-job", jobType: "process-inbound-message" },
    dataConnection: "shared-default",
  };
});

afterAll(async () => {
  await cleanupBusiness(business.businessId);
});

function inboundEvent(text: string, contact: string) {
  return buildMessageReceivedEvent({
    businessId: business.businessId,
    channel: "sms",
    connectionId: "test-connection",
    payload: { text, customerName: "Automation Test Customer", customerContact: contact },
  });
}

describe("Automation reconnection into processInboundMessage (§46.6 task 6)", () => {
  it("an active, confirmed auto_tag rule actually tags the conversation", async () => {
    await rawClient.automationRule.create({
      data: {
        businessId: business.businessId,
        name: "Tag urgent",
        type: "auto_tag",
        isActive: true,
        requiresReconfirmation: false,
        conditions: [{ field: "message_content", operator: "contains", value: "urgent" }],
        actions: [{ type: "auto_tag", value: "Urgent" }],
      },
    });

    const result = await processInboundMessage(ctx, inboundEvent("This is urgent, please help", "+15550001"));

    const tags = await rawClient.conversationTag.findMany({
      where: { conversationId: result.conversationId },
      include: { tag: true },
    });
    expect(tags.some((t) => t.tag.name === "Urgent")).toBe(true);
  });

  it("an active, confirmed auto_reply rule short-circuits the AI call entirely (works with no AI configured)", async () => {
    await rawClient.automationRule.create({
      data: {
        businessId: business.businessId,
        name: "Business hours reply",
        type: "auto_reply",
        isActive: true,
        requiresReconfirmation: false,
        conditions: [{ field: "message_content", operator: "contains", value: "hours" }],
        actions: [{ type: "auto_reply", value: "We are open 9am-5pm, Mon-Fri." }],
      },
    });

    const result = await processInboundMessage(ctx, inboundEvent("What are your hours?", "+15550002"));

    expect(result.response).toBe("We are open 9am-5pm, Mon-Fri.");

    const messages = await rawClient.message.findMany({ where: { conversationId: result.conversationId, role: "assistant" } });
    expect(messages.some((m) => m.content === "We are open 9am-5pm, Mon-Fri.")).toBe(true);
  });

  it("a rule requiring reconfirmation does NOT fire, even if isActive", async () => {
    await rawClient.automationRule.create({
      data: {
        businessId: business.businessId,
        name: "Pre-existing dormant rule",
        type: "auto_reply",
        isActive: true,
        requiresReconfirmation: true, // simulates a pre-Phase-6 row the migration flagged
        conditions: [{ field: "message_content", operator: "contains", value: "dormant-trigger" }],
        actions: [{ type: "auto_reply", value: "This should never be sent." }],
      },
    });

    const result = await processInboundMessage(ctx, inboundEvent("dormant-trigger test message", "+15550003"));

    // No AI provider is configured for this business, so the real chat()
    // fallback ("AI is not configured...") proves the rule was skipped —
    // if it had fired, the response would be the rule's exact text instead.
    expect(result.response).not.toBe("This should never be sent.");
  });

  it("an inactive rule does not fire", async () => {
    await rawClient.automationRule.create({
      data: {
        businessId: business.businessId,
        name: "Disabled rule",
        type: "auto_reply",
        isActive: false,
        requiresReconfirmation: false,
        conditions: [{ field: "message_content", operator: "contains", value: "inactive-trigger" }],
        actions: [{ type: "auto_reply", value: "Should not fire either." }],
      },
    });

    const result = await processInboundMessage(ctx, inboundEvent("inactive-trigger test message", "+15550004"));
    expect(result.response).not.toBe("Should not fire either.");
  });
});
