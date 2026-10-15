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

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
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
    resourceScope: { kind: "workspace" as const, customerProfileAccess: "write" as const },
  };
}

async function seedConversation(marker: string) {
  const connection = await rawClient.channelConnection.create({
    data: {
      businessId: business.businessId,
      type: TEST_CHANNEL,
      name: `conn-${marker}`,
      isActive: true,
    },
  });
  return rawClient.conversation.create({
    data: {
      businessId: business.businessId,
      channel: TEST_CHANNEL,
      customerName: "Follow-up Customer",
      customerContact: `+1555${marker}`,
      metadata: { channelConnectionId: connection.id },
    },
  });
}

/**
 * A real (short) delay, not 0: the fake queue's timer is a real `setTimeout`, so with a 0 delay
 * the job could run — and flip the row to "succeeded" — between scheduling and the assertion
 * that it is still "scheduled" (a timing flake seen under load in CI). `__drainForTests()` waits
 * the delay out, so the test still observes both states deterministically.
 */
const DELAY_HOURS = 0.0006; // ~2.2 s

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
      { conversationId: conversation.id, message: "Just checking in!", delayHours: DELAY_HOURS },
      { toolCallId: "tc-followup-happy" }
    );

    expect(requested.status).toBe("scheduled");

    const actionRow = await rawClient.actionExecution.findFirst({
      where: {
        businessId: business.businessId,
        tool: "schedule_followup",
        idempotencyKey: `${business.businessId}:tc-followup-happy`,
      },
    });
    expect(actionRow?.status).toBe("scheduled");
    expect(actionRow?.conversationId).toBe(conversation.id);

    await (jobQueue as unknown as FakeJobQueue).__drainForTests();

    const finalRow = await rawClient.actionExecution.findUnique({ where: { id: actionRow!.id } });
    expect(finalRow?.status).toBe("succeeded");
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toEqual({
      to: conversation.customerContact,
      text: "Just checking in!",
    });

    const savedMessage = await rawClient.message.findFirst({
      where: { conversationId: conversation.id, role: "assistant" },
    });
    expect(savedMessage?.content).toBe("Just checking in!");
  });

  // Post-Phase-7 hardening (browser acceptance pass): the model is never told
  // its conversation's id — the system prompt does not contain it and no tool
  // returns it — so it cannot supply one. The runtime conversation (which the
  // orchestrator already passes to every tool call) is the only source of
  // truth; asking the model for it made the tool unusable with a real model.
  it("uses the runtime conversation when the model supplies no conversationId (a model cannot know it)", async () => {
    sentMessages = [];
    sendBehavior = () => ({ success: true });
    const conversation = await seedConversation("runtimeconv");

    const requested = await toolRegistry.execute(
      aiCtx(conversation.id),
      "schedule_followup",
      { message: "Following up as promised", delayHours: DELAY_HOURS },
      { toolCallId: "tc-followup-runtime-conv", conversationId: conversation.id }
    );

    expect(requested.status).toBe("scheduled");
    await (jobQueue as unknown as FakeJobQueue).__drainForTests();
    expect(sentMessages).toEqual([
      { to: conversation.customerContact, text: "Following up as promised" },
    ]);
  });

  it("ignores a model-supplied conversationId when a runtime conversation exists (an AI cannot aim a follow-up elsewhere)", async () => {
    sentMessages = [];
    sendBehavior = () => ({ success: true });
    const conversation = await seedConversation("guessedid");
    const other = await rawClient.conversation.create({
      data: {
        businessId: business.businessId,
        channel: TEST_CHANNEL,
        customerName: "Someone Else",
        customerContact: "+15559999999",
      },
    });

    const requested = await toolRegistry.execute(
      aiCtx(conversation.id),
      "schedule_followup",
      { conversationId: other.id, message: "Following up as promised", delayHours: DELAY_HOURS },
      { toolCallId: "tc-followup-guessed-id", conversationId: conversation.id }
    );

    expect(requested.status).toBe("scheduled");
    await (jobQueue as unknown as FakeJobQueue).__drainForTests();
    expect(sentMessages).toEqual([
      { to: conversation.customerContact, text: "Following up as promised" },
    ]);
  });

  it("fails honestly when neither the model nor the runtime supplies a conversation", async () => {
    const result = await toolRegistry.execute(
      aiCtx("no-conv"),
      "schedule_followup",
      { message: "hi", delayHours: 1 },
      { toolCallId: "tc-followup-no-conv-at-all" }
    );
    expect(result.success).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("fails honestly when no active connection exists for the conversation's channel", async () => {
    const conversation = await rawClient.conversation.create({
      data: {
        businessId: business.businessId,
        channel: "no-connection-channel",
        customerName: "No Conn",
        customerContact: "+15550000",
      },
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
      if (attempts === 1)
        return {
          success: false,
          outcome: "rejected",
          retryable: true,
          error: "simulated transient refusal",
        };
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
        input: { conversationId: conversation.id, message: "Retry me" },
        conversationId: conversation.id,
        requestedBy: "ai",
        idempotencyKey,
      },
    });

    const queue = new PgBossJobQueue(TEST_DATABASE_URL, {
      schema: "followup_retry_" + process.pid,
    });
    try {
      queue.registerHandler(SEND_FOLLOWUP_JOB, handleSendFollowup);
      await queue.start();

      await queue.enqueue<SendFollowupPayload>(SEND_FOLLOWUP_JOB, {
        businessId: business.businessId,
        conversationId: conversation.id,
        connectionId: (conversation.metadata as { channelConnectionId: string })
          .channelConnectionId,
        channel: TEST_CHANNEL,
        to: conversation.customerContact,
        message: "Retry me",
        idempotencyKey,
      });

      await waitUntil(() => sentMessages.length >= 1 && attempts >= 2, 35000);
      await new Promise((resolve) => setTimeout(resolve, 3000)); // watch for a stray duplicate delivery

      expect(attempts).toBe(2);
      expect(sentMessages).toHaveLength(1); // the failed attempt never actually "sent" anything real
      expect(sentMessages[0].text).toBe("Retry me");

      const finalRow = await rawClient.actionExecution.findFirst({
        where: { businessId: business.businessId, idempotencyKey },
      });
      expect(finalRow?.status).toBe("succeeded");
    } finally {
      await queue.stop();
    }
  }, 45000);
});

describe("P1 authoritative follow-up lineage", () => {
  it("does not redirect an AI actor when runtime binding is omitted and the model supplies a different target", async () => {
    const a = await seedConversation("bound-ai"),
      b = await seedConversation("other-ai");
    const schedule = vi.spyOn(jobQueue, "schedule").mockResolvedValueOnce("paused-lineage-fixture");
    try {
      const result = await toolRegistry.execute(
        aiCtx(a.id),
        "schedule_followup",
        { conversationId: b.id, message: "Bound only to A", delayHours: 1 },
        { toolCallId: "lineage-ai-fallback" }
      );
      expect(result.status).toBe("scheduled");
      expect(schedule).toHaveBeenCalledWith(
        SEND_FOLLOWUP_JOB,
        expect.objectContaining({ conversationId: a.id, to: a.customerContact }),
        expect.anything()
      );
      expect(
        await rawClient.actionExecution.findFirst({
          where: {
            businessId: business.businessId,
            idempotencyKey: `${business.businessId}:lineage-ai-fallback`,
          },
        })
      ).toMatchObject({ conversationId: a.id });
    } finally {
      schedule.mockRestore();
    }
  });
  it("rejects disagreement between actual AI/work/runtime parents before recording or queuing", async () => {
    const a = await seedConversation("conflict-ai"),
      b = await seedConversation("conflict-runtime");
    const schedule = vi.spyOn(jobQueue, "schedule").mockResolvedValue("paused-conflict-fixture");
    try {
      const result = await toolRegistry.execute(
        aiCtx(a.id),
        "schedule_followup",
        { message: "Must not redirect", delayHours: 1 },
        { toolCallId: "lineage-conflicting-runtime", conversationId: b.id }
      );
      expect(result.success).toBe(false);
      expect(schedule).not.toHaveBeenCalled();
      expect(
        await rawClient.actionExecution.count({
          where: {
            businessId: business.businessId,
            idempotencyKey: `${business.businessId}:lineage-conflicting-runtime`,
          },
        })
      ).toBe(0);
    } finally {
      schedule.mockRestore();
    }
  });
  it("binds a direct human argument only after scoped authorization, and rejects an excluded target", async () => {
    const a = await seedConversation("human-target"),
      b = await seedConversation("excluded-human-target");
    const human: TenantContext = {
      ...business.ctx,
      resourceScope: {
        kind: "connections",
        connectionIds: [(a.metadata as { channelConnectionId: string }).channelConnectionId],
        customerProfileAccess: "none",
      },
    };
    const schedule = vi.spyOn(jobQueue, "schedule").mockResolvedValue("paused-human-fixture");
    try {
      const allowed = await toolRegistry.execute(
        human,
        "schedule_followup",
        { conversationId: a.id, message: "Scoped target", delayHours: 1 },
        { idempotencyKey: "lineage-human" }
      );
      expect(allowed.status).toBe("scheduled");
      expect(
        await rawClient.actionExecution.findFirst({
          where: { businessId: business.businessId, idempotencyKey: "lineage-human" },
        })
      ).toMatchObject({ conversationId: a.id });
      schedule.mockClear();
      const denied = await toolRegistry.execute(
        human,
        "schedule_followup",
        { conversationId: b.id, message: "Excluded target", delayHours: 1 },
        { idempotencyKey: "lineage-human-excluded" }
      );
      expect(denied.success).toBe(false);
      expect(schedule).not.toHaveBeenCalled();
      expect(
        await rawClient.actionExecution.count({
          where: { businessId: business.businessId, idempotencyKey: "lineage-human-excluded" },
        })
      ).toBe(0);
    } finally {
      schedule.mockRestore();
    }
  });
  it("retirement discovers and redacts an action created without explicit runtime conversation", async () => {
    const conversation = await seedConversation("retire-bound");
    const schedule = vi
      .spyOn(jobQueue, "schedule")
      .mockResolvedValueOnce("paused-retirement-fixture");
    try {
      const result = await toolRegistry.execute(
        aiCtx(conversation.id),
        "schedule_followup",
        { conversationId: conversation.id, message: "Synthetic private follow-up", delayHours: 1 },
        { toolCallId: "lineage-retirement" }
      );
      expect(result.status).toBe("scheduled");
      const row = await rawClient.actionExecution.findFirstOrThrow({
        where: {
          businessId: business.businessId,
          idempotencyKey: `${business.businessId}:lineage-retirement`,
        },
      });
      const { remove } = await import("@/lib/conversations/service");
      await remove(business.ctx, conversation.id);
      const retired = await rawClient.actionExecution.findUniqueOrThrow({ where: { id: row.id } });
      expect(retired).toMatchObject({ input: {}, status: "cancelled", conversationId: null });
      expect(retired.retiredAt).not.toBeNull();
    } finally {
      schedule.mockRestore();
    }
  });
  it("does not dispatch an old scheduled action with no persisted conversation parent", async () => {
    const conversation = await seedConversation("unbound-old-action"),
      idempotencyKey = "lineage-unbound-job";
    sentMessages = [];
    sendBehavior = () => ({ success: true });
    await rawClient.actionExecution.create({
      data: {
        businessId: business.businessId,
        tool: "schedule_followup",
        status: "scheduled",
        input: { conversationId: conversation.id, message: "Unbound must not send" },
        conversationId: null,
        requestedBy: "ai",
        idempotencyKey,
      },
    });
    const handler = handleSendFollowup(
      {
        businessId: business.businessId,
        role: null,
        actor: { kind: "system_job", jobId: "lineage-old-job", jobType: SEND_FOLLOWUP_JOB },
        dataConnection: "shared-default",
      },
      {
        businessId: business.businessId,
        conversationId: conversation.id,
        connectionId: (conversation.metadata as { channelConnectionId: string })
          .channelConnectionId,
        channel: TEST_CHANNEL,
        to: conversation.customerContact!,
        message: "Unbound must not send",
        idempotencyKey,
      }
    );
    const outcome = await handler.then(
      () => ({ completed: true }),
      (error) => ({ error })
    );
    expect(outcome).toMatchObject({ error: { statusCode: 404 } });
    expect(sentMessages).toEqual([]);
  });
});

describe("P1 follow-up attempt binding", () => {
  it("does not return another parent's cached result when a client reuses an attempt key", async () => {
    const a = await seedConversation("cached-parent-a"),
      b = await seedConversation("cached-parent-b");
    const schedule = vi
      .spyOn(jobQueue, "schedule")
      .mockResolvedValue("paused-cache-parent-fixture");
    try {
      const first = await toolRegistry.execute(
        business.ctx,
        "schedule_followup",
        { conversationId: a.id, message: "A only", delayHours: 1 },
        { idempotencyKey: "lineage-shared-attempt" }
      );
      expect(first.status).toBe("scheduled");
      schedule.mockClear();
      const replay = await toolRegistry.execute(
        business.ctx,
        "schedule_followup",
        { conversationId: a.id, message: "A only", delayHours: 1 },
        { idempotencyKey: "lineage-shared-attempt" }
      );
      expect(replay.success).toBe(true);
      expect(replay.status).toBe("scheduled");
      expect(schedule).not.toHaveBeenCalled();
      const second = await toolRegistry.execute(
        business.ctx,
        "schedule_followup",
        { conversationId: b.id, message: "B cannot reuse A", delayHours: 1 },
        { idempotencyKey: "lineage-shared-attempt" }
      );
      expect(second.success).toBe(false);
      expect(second.status).toBe("failed");
      expect(schedule).not.toHaveBeenCalled();
      expect(
        await rawClient.actionExecution.count({
          where: { businessId: business.businessId, idempotencyKey: "lineage-shared-attempt" },
        })
      ).toBe(1);
    } finally {
      schedule.mockRestore();
    }
  });
});

describe("P1 follow-up approval and admission edges", () => {
  it("refuses a legacy unbound approval before claiming it or enqueueing", async () => {
    const conversation = await seedConversation("legacy-approval");
    const record = await rawClient.actionExecution.create({
      data: {
        businessId: business.businessId,
        tool: "schedule_followup",
        status: "pending_approval",
        input: {
          conversationId: conversation.id,
          message: "Legacy unbound approval",
          delayHours: 1,
        },
        conversationId: null,
        requestedBy: "ai",
        idempotencyKey: "lineage-unbound-approval",
      },
    });
    const schedule = vi
      .spyOn(jobQueue, "schedule")
      .mockResolvedValueOnce("paused-legacy-approval-fixture");
    try {
      const outcome = await toolRegistry.approve(business.ctx, record.id).then(
        (result) => ({ result }),
        (error) => ({ error })
      );
      expect(outcome).toMatchObject({ error: { statusCode: 409 } });
      expect(schedule).not.toHaveBeenCalled();
      expect(
        (await rawClient.actionExecution.findUniqueOrThrow({ where: { id: record.id } })).status
      ).toBe("pending_approval");
    } finally {
      schedule.mockRestore();
    }
  });
  it("an approval-gated call without runtime binds and approves exactly the persisted parent", async () => {
    const conversation = await seedConversation("bound-approval");
    const previous = await rawClient.toolPolicy.findUnique({
      where: { businessId_tool: { businessId: business.businessId, tool: "schedule_followup" } },
    });
    await rawClient.toolPolicy.upsert({
      where: { businessId_tool: { businessId: business.businessId, tool: "schedule_followup" } },
      create: {
        businessId: business.businessId,
        tool: "schedule_followup",
        enabledForTenant: true,
        allowedForAI: true,
        allowedForHumanRoles: ["owner"],
        requiresHumanApproval: true,
      },
      update: { requiresHumanApproval: true },
    });
    const schedule = vi
      .spyOn(jobQueue, "schedule")
      .mockResolvedValueOnce("paused-bound-approval-fixture");
    try {
      expect(
        (
          await toolRegistry.execute(
            aiCtx(conversation.id),
            "schedule_followup",
            { message: "Approved bound target", delayHours: 1 },
            { toolCallId: "lineage-bound-approval" }
          )
        ).status
      ).toBe("pending_approval");
      const record = await rawClient.actionExecution.findFirstOrThrow({
        where: {
          businessId: business.businessId,
          idempotencyKey: `${business.businessId}:lineage-bound-approval`,
        },
      });
      expect(record.conversationId).toBe(conversation.id);
      expect((await toolRegistry.approve(business.ctx, record.id)).status).toBe("scheduled");
      expect(schedule).toHaveBeenCalledWith(
        SEND_FOLLOWUP_JOB,
        expect.objectContaining({ conversationId: conversation.id }),
        expect.anything()
      );
    } finally {
      schedule.mockRestore();
      if (previous)
        await rawClient.toolPolicy.update({
          where: { id: previous.id },
          data: { requiresHumanApproval: previous.requiresHumanApproval },
        });
      else
        await rawClient.toolPolicy.delete({
          where: {
            businessId_tool: { businessId: business.businessId, tool: "schedule_followup" },
          },
        });
    }
  });
  it("cannot reuse another tool's cached result for a follow-up", async () => {
    const conversation = await seedConversation("cached-other-tool");
    await rawClient.actionExecution.create({
      data: {
        businessId: business.businessId,
        tool: "create_ticket",
        status: "succeeded",
        input: {},
        result: { success: true, message: "Other tool result" },
        conversationId: conversation.id,
        requestedBy: "ai",
        idempotencyKey: "lineage-other-tool-attempt",
      },
    });
    const result = await toolRegistry.execute(
      business.ctx,
      "schedule_followup",
      { conversationId: conversation.id, message: "No cross-tool cache", delayHours: 1 },
      { idempotencyKey: "lineage-other-tool-attempt" }
    );
    expect(result.success).toBe(false);
    expect(result.message).not.toBe("Other tool result");
  });
  it("checks workBinding against actual AI/runtime parent and rejects before enqueue", async () => {
    const a = await seedConversation("work-parent-a"),
      b = await seedConversation("work-parent-b");
    const schedule = vi
      .spyOn(jobQueue, "schedule")
      .mockResolvedValueOnce("paused-work-parent-fixture");
    try {
      const result = await toolRegistry.execute(
        { ...aiCtx(a.id), workBinding: { conversationId: b.id } },
        "schedule_followup",
        { message: "Conflicting actual parents", delayHours: 1 },
        { conversationId: a.id, toolCallId: "lineage-work-parent-conflict" }
      );
      expect(result.success).toBe(false);
      expect(schedule).not.toHaveBeenCalled();
      expect(
        await rawClient.actionExecution.count({
          where: {
            businessId: business.businessId,
            idempotencyKey: `${business.businessId}:lineage-work-parent-conflict`,
          },
        })
      ).toBe(0);
    } finally {
      schedule.mockRestore();
    }
  });
  it("retirement between preflight and admission leaves no action payload or queued job", async () => {
    const conversation = await seedConversation("retire-after-preflight");
    const tool = toolRegistry.get("schedule_followup")!,
      original = tool.resolveConversationId!;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      hold = new Promise<void>((r) => {
        release = r;
      });
    const binding = vi
      .spyOn(tool, "resolveConversationId")
      .mockImplementationOnce(async (...args) => {
        const id = await original(...args);
        entered();
        await hold;
        return id;
      });
    const schedule = vi
      .spyOn(jobQueue, "schedule")
      .mockResolvedValueOnce("paused-retired-admission-fixture");
    try {
      const pending = toolRegistry.execute(
        aiCtx(conversation.id),
        "schedule_followup",
        { message: "Private retired-before-admission", delayHours: 1 },
        { toolCallId: "lineage-retire-before-admission" }
      );
      const outcome = pending.then(
        (result) => ({ result }),
        (error) => ({ error })
      );
      await ready;
      const { remove } = await import("@/lib/conversations/service");
      await remove(business.ctx, conversation.id);
      release();
      const value = await outcome;
      expect("error" in value || value.result?.success === false).toBe(true);
      expect(schedule).not.toHaveBeenCalled();
      expect(
        await rawClient.actionExecution.count({
          where: {
            businessId: business.businessId,
            idempotencyKey: `${business.businessId}:lineage-retire-before-admission`,
          },
        })
      ).toBe(0);
    } finally {
      release();
      binding.mockRestore();
      schedule.mockRestore();
    }
  });
});
