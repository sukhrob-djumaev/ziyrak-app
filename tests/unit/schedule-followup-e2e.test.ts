import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/**
 * PLAN.md §24.3/§34.3 item 5/§46.6 PR3 — "Schedule follow-up → durable job
 * created → worker processes it → result recorded, exactly once even
 * under retry." §34.3 item 5 explicitly allows either `FakeJobQueue` or a
 * real pg-boss instance for this test; this file uses both, for what each
 * is actually good at: the shared `jobQueue` (FakeJobQueue under
 * NODE_ENV=test) for the tool's own happy-path wiring, and a dedicated
 * real `PgBossJobQueue` for the "exactly once under retry" clause
 * specifically, since FakeJobQueue has no retry mechanism to exercise at
 * all (§33.4 item 6 needs a real queue by construction).
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma as rawClient } from "@/lib/prisma/raw-client";
import { toolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/builtin";
import { jobQueue } from "@/lib/jobs/queue";
import type { FakeJobQueue } from "@/lib/jobs/fake-job-queue";
import { PgBossJobQueue } from "@/lib/jobs/pgboss-job-queue";
import { handleSendFollowup } from "@/lib/jobs/handlers/send-followup";
import { SEND_FOLLOWUP_JOB, type SendFollowupPayload } from "@/lib/jobs/job-types";
import { registerChannelAdapter } from "@/lib/channels/registry";
import type { ChannelAdapter, SendResult } from "@/lib/channels/types";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import type { TenantContext } from "@/lib/tenancy/context";

const TEST_CHANNEL = "test-followup-channel";
const TEST_DATABASE_URL = process.env.DATABASE_URL!;

async function waitUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

let business: SeededBusiness;
let sentMessages: Array<{ to: string; text: string }>;
let sendBehavior: (to: string, text: string) => SendResult | Promise<SendResult>;

beforeAll(async () => {
  business = await seedBusiness("schedule-followup-e2e");

  const fakeAdapter: ChannelAdapter = {
    type: TEST_CHANNEL,
    capabilities: { supportsMedia: false, supportsTemplates: false, supportsTypingIndicator: false, supportsDeliveryReceipts: false, supportsMultipleConnections: false },
    async validateInbound() {
      return { kind: "rejected", reason: "not used in this test" };
    },
    async sendMessage(_ctx, _connectionId, to, content) {
      const result = await sendBehavior(to, content.text);
      if (result.success) sentMessages.push({ to, text: content.text }); // only a genuinely successful send counts as "delivered"
      return result;
    },
    async getStatus() {
      return { connected: true };
    },
  };
  registerChannelAdapter(TEST_CHANNEL, fakeAdapter);
});

afterAll(async () => {
  await cleanupBusiness(business.businessId);
});

function aiCtx(conversationId: string): TenantContext {
  return {
    businessId: business.businessId,
    role: null,
    actor: { kind: "ai_agent", conversationId, model: "test-model" },
    dataConnection: "shared-default",
  };
}

async function seedConversation(marker: string) {
  await rawClient.channelConnection.create({
    data: { businessId: business.businessId, type: TEST_CHANNEL, name: `conn-${marker}`, isActive: true },
  });
  return rawClient.conversation.create({
    data: { businessId: business.businessId, channel: TEST_CHANNEL, customerName: "Follow-up Customer", customerContact: `+1555${marker}` },
  });
}

describe("schedule_followup — end-to-end via the tool (§24.3/§34.3 item 5)", () => {
  it("is now exposed to the AI (enabledForTenant defaults to true as of PR3)", async () => {
    const available = await toolRegistry.getAvailableTools(aiCtx("conv-availability"));
    expect(available.some((t) => t.name === "schedule_followup")).toBe(true);
  });

  it("schedules durably (ActionExecution: scheduled), then the queued job sends the message exactly once and marks it succeeded", async () => {
    sentMessages = [];
    sendBehavior = () => ({ success: true });

    const conversation = await seedConversation("happy");

    const requested = await toolRegistry.execute(
      aiCtx(conversation.id),
      "schedule_followup",
      { conversationId: conversation.id, message: "Just checking in!", delayHours: 0 },
      { toolCallId: "tc-followup-happy" }
    );

    expect(requested.status).toBe("scheduled");

    const actionRow = await rawClient.actionExecution.findFirst({
      where: { businessId: business.businessId, tool: "schedule_followup", idempotencyKey: `${business.businessId}:tc-followup-happy` },
    });
    expect(actionRow?.status).toBe("scheduled");

    await (jobQueue as unknown as FakeJobQueue).__drainForTests();

    const finalRow = await rawClient.actionExecution.findUnique({ where: { id: actionRow!.id } });
    expect(finalRow?.status).toBe("succeeded");
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toEqual({ to: conversation.customerContact, text: "Just checking in!" });

    const savedMessage = await rawClient.message.findFirst({ where: { conversationId: conversation.id, role: "assistant" } });
    expect(savedMessage?.content).toBe("Just checking in!");
  });

  it("fails honestly when no active connection exists for the conversation's channel", async () => {
    const conversation = await rawClient.conversation.create({
      data: { businessId: business.businessId, channel: "no-connection-channel", customerName: "No Conn", customerContact: "+15550000" },
    });

    const result = await toolRegistry.execute(
      aiCtx(conversation.id),
      "schedule_followup",
      { conversationId: conversation.id, message: "hi", delayHours: 1 },
      { toolCallId: "tc-no-connection" }
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("No active");
  });
});

describe("send-followup job handler — exactly once under retry (§31.2/§33.4 item 6, real PgBossJobQueue)", () => {
  it("a transient send failure followed by pg-boss's own retry still sends exactly one message", async () => {
    sentMessages = [];
    let attempts = 0;
    sendBehavior = () => {
      attempts++;
      if (attempts === 1) return { success: false, error: "simulated transient failure" };
      return { success: true };
    };

    const conversation = await seedConversation("retry");
    const idempotencyKey = `${business.businessId}:retry-test-${Date.now()}`;

    // The real ActionExecution row send-followup's handler looks up and updates.
    await rawClient.actionExecution.create({
      data: {
        businessId: business.businessId,
        tool: "schedule_followup",
        status: "scheduled",
        input: { conversationId: conversation.id },
        conversationId: conversation.id,
        requestedBy: "ai",
        idempotencyKey,
      },
    });

    const queue = new PgBossJobQueue(TEST_DATABASE_URL);
    try {
      queue.registerHandler(SEND_FOLLOWUP_JOB, handleSendFollowup);
      await queue.start();

      await queue.enqueue<SendFollowupPayload>(SEND_FOLLOWUP_JOB, {
        businessId: business.businessId,
        conversationId: conversation.id,
        connectionId: "unused-connection-id",
        channel: TEST_CHANNEL,
        to: conversation.customerContact,
        message: "Retry me",
        idempotencyKey,
      });

      await waitUntil(() => sentMessages.length >= 1 && attempts >= 2, 15000);
      await new Promise((resolve) => setTimeout(resolve, 3000)); // watch for a stray duplicate delivery

      expect(attempts).toBe(2);
      expect(sentMessages).toHaveLength(1); // the failed attempt never actually "sent" anything real
      expect(sentMessages[0].text).toBe("Retry me");

      const finalRow = await rawClient.actionExecution.findFirst({ where: { businessId: business.businessId, idempotencyKey } });
      expect(finalRow?.status).toBe("succeeded");
    } finally {
      await queue.stop();
    }
  }, 25000);
});
