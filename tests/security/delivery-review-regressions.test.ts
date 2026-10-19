import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import "@/lib/tools/builtin";
import { toolRegistry } from "@/lib/tools/registry";
import { authorizeSeededFollowup } from "../helpers/followup-fixtures";
import { SEND_FOLLOWUP_JOB } from "@/lib/jobs/job-types";
import type { TenantContext } from "@/lib/tenancy/context";
import { jobQueue } from "@/lib/jobs/queue";
import { handleSendFollowup } from "@/lib/jobs/handlers/send-followup";
import { deleteCustomerData } from "@/lib/customers/gdpr";
import * as delivery from "@/lib/conversations/delivery";
import { registerChannelAdapter } from "@/lib/channels/registry";
let business: SeededBusiness;
let connectionId: string;
const channel = "review-regression";
beforeAll(async () => {
  business = await seedBusiness("delivery-review");
  connectionId = (
    await prisma.channelConnection.create({
      data: { businessId: business.businessId, type: channel, name: "First", isActive: true },
    })
  ).id;
  registerChannelAdapter(channel, {
    type: channel,
    capabilities: {
      supportsMedia: false,
      supportsTemplates: false,
      supportsTypingIndicator: false,
      supportsDeliveryReceipts: false,
      supportsMultipleConnections: true,
    },
    validateInbound: async () => ({ kind: "rejected", reason: "test" }),
    getStatus: async () => ({ connected: true }),
    sendMessage: async () => ({ success: false, outcome: "unknown" }),
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  if (business) await cleanupBusiness(business.businessId);
});
function worker(): TenantContext {
  return {
    ...business.ctx,
    role: null,
    authorization: undefined,
    actor: { kind: "system_job", jobId: randomUUID(), jobType: SEND_FOLLOWUP_JOB },
  };
}
async function fixture() {
  const customer = await prisma.customer.create({
    data: { businessId: business.businessId, name: "Synthetic private customer" },
  });
  const conversation = await prisma.conversation.create({
    data: {
      businessId: business.businessId,
      customerId: customer.id,
      channel,
      customerContact: "synthetic-private-recipient",
      metadata: { channelConnectionId: connectionId },
    },
  });
  const idempotencyKey = randomUUID();
  const message = "Synthetic private follow-up";
  const action = await prisma.actionExecution.create({
    data: {
      businessId: business.businessId,
      tool: "schedule_followup",
      status: "scheduled",
      conversationId: conversation.id,
      input: { message },
      requestedBy: business.ownerUserId,
      idempotencyKey,
    },
  });
  await authorizeSeededFollowup(business.ctx, action.id, conversation.id, connectionId);
  const payload = {
    businessId: business.businessId,
    conversationId: conversation.id,
    channel,
    connectionId,
    to: conversation.customerContact,
    message,
    idempotencyKey,
  };
  return { customer, conversation, action, payload };
}
describe("independent delivery review regressions (real Postgres, synthetic provider)", () => {
  it("schedules through the conversation's owning connection when two are active", async () => {
    const second = await prisma.channelConnection.create({
      data: { businessId: business.businessId, type: channel, name: "Second", isActive: true },
    });
    const f = await fixture();
    await prisma.conversation.update({
      where: { id: f.conversation.id },
      data: { metadata: { channelConnectionId: second.id } },
    });
    const schedule = vi.spyOn(jobQueue, "schedule").mockResolvedValue("synthetic-job");
    try {
      const result = await toolRegistry.execute(
        business.ctx,
        "schedule_followup",
        { message: "Follow-up", delayHours: 1 },
        { conversationId: f.conversation.id, idempotencyKey: randomUUID() }
      );
      expect(result.status).toBe("scheduled");
      expect(schedule.mock.calls[0][1]).toMatchObject({ connectionId: second.id });
    } finally {
      schedule.mockRestore();
    }
  });
  it("does not recreate cached PII when an erased customer's delayed follow-up becomes due", async () => {
    const f = await fixture();
    await deleteCustomerData(business.ctx, f.customer.id);
    await handleSendFollowup(worker(), f.payload);
    expect(
      (await prisma.actionExecution.findUniqueOrThrow({ where: { id: f.action.id } })).status
    ).toBe("cancelled");
    expect(await prisma.deliveryOperation.count({ where: { actionId: f.action.id } })).toBe(0);
  });
  it("redacts customer content from delivery recovery audit reasons", async () => {
    const f = await fixture();
    const op = await delivery.ensureDelivery(business.ctx, {
      operationKey: randomUUID(),
      kind: "followup",
      actionId: f.action.id,
      conversationId: f.conversation.id,
      channel,
      connectionId,
      recipient: f.payload.to,
      response: f.payload.message,
    });
    await prisma.deliveryOperation.update({ where: { id: op.id }, data: { status: "unknown" } });
    await delivery.recoverDelivery(business.ctx, op.id, {
      decision: "cancel",
      reason: "Synthetic private customer confirmed cancellation",
      requestId: randomUUID(),
    });
    await deleteCustomerData(business.ctx, f.customer.id);
    const audit = await prisma.activityLog.findFirstOrThrow({
      where: { entityId: op.id, action: "delivery.recovered" },
    });
    expect(audit.metadata).toMatchObject({
      reason: "[REDACTED - GDPR]",
      actorId: business.ownerUserId,
      decision: "cancel",
    });
  });
  it("redacts a recovery audit committed while erasure waits for an inbound operation", async () => {
    const f = await fixture();
    const op = await delivery.ensureDelivery(business.ctx, {
      operationKey: randomUUID(),
      kind: "inbound",
      conversationId: f.conversation.id,
      channel,
      connectionId,
      recipient: f.payload.to,
      response: f.payload.message,
    });
    await prisma.deliveryOperation.update({ where: { id: op.id }, data: { status: "unknown" } });
    let erasure: ReturnType<typeof deleteCustomerData> | undefined;
    // Hold the same row lock recovery holds before its audit insertion. The
    // fixture commits that audit only after observing erasure blocked in PG.
    await prisma.$transaction(
      async (tx) => {
        const [backend] = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        await tx.deliveryOperation.update({ where: { id: op.id }, data: { status: "cancelled" } });
        erasure = deleteCustomerData(business.ctx, f.customer.id);
        const deadline = Date.now() + 4000;
        for (;;) {
          const [row] = await prisma.$queryRaw<
            Array<{ blocked: boolean }>
          >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE ${backend.pid} = ANY(pg_blocking_pids(a.pid))) AS blocked`;
          if (row.blocked) break;
          if (Date.now() > deadline)
            throw new Error("Erasure did not reach the controlled row-lock interleaving");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await tx.activityLog.create({
          data: {
            businessId: business.businessId,
            userId: business.ownerUserId,
            userName: "Test operator",
            action: "delivery.recovered",
            entity: "delivery",
            entityId: op.id,
            description: "Controlled concurrent recovery commit",
            metadata: {
              actorId: business.ownerUserId,
              decision: "cancel",
              reason: "Synthetic private audit reason",
            },
          },
        });
      },
      { timeout: 10000 }
    );
    await erasure;
    const audit = await prisma.activityLog.findFirstOrThrow({
      where: { entityId: op.id, action: "delivery.recovered" },
    });
    expect(audit.metadata).toMatchObject({ reason: "[REDACTED - GDPR]" });
  });
  it("does not reopen cancellation when the adapter disappears during dispatch", async () => {
    const f = await fixture();
    const absentChannel = "missing-adapter-review";
    const conn = await prisma.channelConnection.create({
      data: {
        businessId: business.businessId,
        type: absentChannel,
        name: "Absent adapter fixture",
        isActive: true,
      },
    });
    await prisma.conversation.update({
      where: { id: f.conversation.id },
      data: { channel: absentChannel, metadata: { channelConnectionId: conn.id } },
    });
    const op = await delivery.ensureDelivery(business.ctx, {
      operationKey: randomUUID(),
      kind: "followup",
      conversationId: f.conversation.id,
      channel: absentChannel,
      connectionId: conn.id,
      recipient: f.payload.to,
      response: f.payload.message,
    });
    let dispatch: ReturnType<typeof delivery.dispatchDelivery> | undefined;
    await prisma.$transaction(
      async (tx) => {
        const [backend] = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        await tx.deliveryOperation.update({ where: { id: op.id }, data: { status: "cancelled" } });
        dispatch = delivery.dispatchDelivery(business.ctx, op.id);
        const deadline = Date.now() + 4000;
        for (;;) {
          const [row] = await prisma.$queryRaw<
            Array<{ blocked: boolean }>
          >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE ${backend.pid} = ANY(pg_blocking_pids(a.pid))) AS blocked`;
          if (row.blocked) break;
          if (Date.now() > deadline)
            throw new Error("Dispatch did not reach the controlled cancellation interleaving");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      },
      { timeout: 10000 }
    );
    expect((await dispatch)?.status).toBe("cancelled");
  });
  it("preserves cancellation completed before foreign-conversation error handling reads the operation", async () => {
    const foreign = await seedBusiness("foreign-error-cancellation");
    const actual = delivery.prepareDelivery;
    const prepare = vi
      .spyOn(delivery, "prepareDelivery")
      .mockImplementation(async (ctx, op, callback) => {
        try {
          return await actual(ctx, op, callback);
        } catch (error) {
          await delivery.recoverDelivery(business.ctx, op.id, {
            decision: "cancel",
            reason: "Operator stopped interrupted preparation",
            requestId: randomUUID(),
          });
          throw error;
        }
      });
    try {
      const conv = await prisma.conversation.create({
        data: { businessId: foreign.businessId, channel: "webchat" },
      });
      const { registerInboundEvent } = await import("@/lib/events/inbound-receipt");
      const { handleProcessInboundMessage } = await import("@/lib/conversations/inbound");
      const { buildMessageReceivedEvent } = await import("@/lib/events/types");
      const webchatConnection = await prisma.channelConnection.create({
        data: {
          businessId: business.businessId,
          type: "webchat",
          name: "Collision fixture",
          isActive: true,
        },
      });
      const event = buildMessageReceivedEvent({
        businessId: business.businessId,
        channel: "webchat",
        connectionId: webchatConnection.id,
        conversationId: conv.id,
        payload: {
          text: "Synthetic collision",
          customerName: "Synthetic visitor",
          customerContact: "synthetic-private-recipient",
        },
      });
      const { receiptId } = await registerInboundEvent(business.ctx, {
        source: "webchat",
        externalEventId: randomUUID(),
        eventType: event.type,
        correlationId: event.correlationId,
        event,
      });
      await handleProcessInboundMessage(business.ctx, {
        businessId: business.businessId,
        receiptId,
      });
      const saved = await prisma.deliveryOperation.findFirstOrThrow({ where: { receiptId } });
      expect(saved.status).toBe("cancelled");
      expect(
        (await prisma.inboundEventReceipt.findUniqueOrThrow({ where: { id: receiptId } }))
          .processingStatus
      ).toBe("cancelled");
    } finally {
      prepare.mockRestore();
      await cleanupBusiness(foreign.businessId);
    }
  });
  it("does not overwrite a terminal human decision with a stale worker status", async () => {
    const f = await fixture();
    const actual = delivery.dispatchDelivery;
    const dispatch = vi
      .spyOn(delivery, "dispatchDelivery")
      .mockImplementation(async (ctx, id, authorize) => {
        const stale = await actual(ctx, id, authorize);
        expect(stale.status).toBe("unknown");
        await delivery.recoverDelivery(business.ctx, id, {
          decision: "cancel",
          reason: "Operator completed review",
          requestId: randomUUID(),
        });
        return stale;
      });
    try {
      await handleSendFollowup(worker(), f.payload);
      expect(
        (await prisma.actionExecution.findUniqueOrThrow({ where: { id: f.action.id } })).status
      ).toBe("cancelled");
    } finally {
      dispatch.mockRestore();
    }
  });
});
