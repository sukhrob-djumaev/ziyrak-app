import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/lib/tenancy/context";

const f = vi.hoisted(() => ({
  status: "scheduled",
  ops: {} as Record<string, Record<string, unknown>>,
  receiptStatus: "enqueued",
  send: vi.fn(),
  messageCreate: vi.fn(),
  actionUpdate: vi.fn(),
  markReceipt: vi.fn(),
  chat: vi.fn(),
  event: {
    id: "audit-event",
    businessId: "audit-business",
    type: "message.received",
    source: { channel: "audit_channel", connectionId: "audit-connection" },
    conversationId: "audit-conversation",
    payload: { text: "hello", customerContact: "audit-recipient", customerName: "Audit" },
  },
}));
vi.mock("@/lib/tenancy/scoped-prisma", () => ({
  getScopedPrisma: () => {
    const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) => {
        if (value && typeof value === "object" && "in" in value)
          return (value.in as unknown[]).includes(row[key]);
        if (value && typeof value === "object" && "lt" in value)
          return row[key] instanceof Date && (row[key] as Date) < (value.lt as Date);
        if (key === "updatedAt") return (row[key] as Date).getTime() === (value as Date).getTime();
        return row[key] === value;
      });
    const update = (row: Record<string, unknown>, data: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(data))
        row[key] =
          value && typeof value === "object" && "increment" in value
            ? Number(row[key]) + Number(value.increment)
            : value;
      row.updatedAt = new Date();
      return row;
    };
    const deliveryOperation = {
      upsert: vi.fn(async ({ where, create }) => {
        const found = Object.values(f.ops).find(
          (row) => row.operationKey === where.businessId_operationKey.operationKey
        );
        if (found) return found;
        const row = {
          id: "operation-" + Object.keys(f.ops).length,
          response: null,
          metadata: {},
          retryable: false,
          providerMessageId: null,
          claimToken: null,
          leaseUntil: null,
          attempts: 0,
          errorMessage: null,
          recoveryLog: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        };
        f.ops[row.id] = row;
        return row;
      }),
      findUnique: vi.fn(async ({ where }) =>
        where.id
          ? f.ops[where.id]
          : Object.values(f.ops).find(
              (row) => row.operationKey === where.businessId_operationKey.operationKey
            )
      ),
      findUniqueOrThrow: vi.fn(async ({ where }) => {
        const row = f.ops[where.id];
        if (!row) throw new Error("Not found");
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        let count = 0;
        for (const row of Object.values(f.ops))
          if (matches(row, where)) {
            update(row, data);
            count++;
          }
        return { count };
      }),
      update: vi.fn(async ({ where, data }) => update(f.ops[where.id], data)),
    };
    const db = {
      deliveryOperation,
      actionExecution: {
        findUnique: async () => ({
          id: "audit-action",
          updatedAt: new Date(0),
          status: f.status,
          tool: "schedule_followup",
          input: { message: "Audit follow-up" },
          conversationId: "audit-conversation",
        }),
        update: f.actionUpdate,
        updateMany: async () => ({ count: 1 }),
      },
      inboundEventReceipt: {
        findUnique: async () => ({ processingStatus: f.receiptStatus }),
        update: async ({ data }) => {
          f.receiptStatus = data.processingStatus;
          return {};
        },
      },
      conversation: {
        findUnique: async () => ({
          id: "audit-conversation",
          channel: "audit_channel",
          customerContact: "audit-recipient",
          metadata: { channelConnectionId: "audit-connection" },
        }),
      },
      channelConnection: {
        findFirst: async () => ({ id: "audit-connection", isActive: true, type: "audit_channel" }),
      },
      message: { upsert: f.messageCreate },
      activityLog: { create: vi.fn() },
      $transaction: vi.fn(),
    };
    db.$transaction.mockImplementation(async (fn) => fn(db));
    return db;
  },
}));
vi.mock("@/lib/channels/registry", () => ({ getChannelAdapter: () => ({ sendMessage: f.send }) }));
vi.mock("@/lib/jobs/queue", () => ({
  PROCESS_INBOUND_MESSAGE_JOB: "process-inbound-message",
  jobQueue: { registerHandler: vi.fn() },
}));
vi.mock("@/lib/observability/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("@/lib/observability/activity", () => ({ logActivity: vi.fn() }));
vi.mock("@/lib/ai/engine", () => ({ chat: f.chat }));
vi.mock("@/lib/automations/automation", () => ({
  evaluateRules: async () => [],
  applyAutomationActions: async () => undefined,
}));
vi.mock("@/lib/customers/customer-resolver", () => ({ resolveCustomer: vi.fn() }));
vi.mock("@/lib/conversations/conversation-service", () => ({ createNewConversation: vi.fn() }));
vi.mock("@/lib/events/inbound-receipt", () => ({
  loadReceiptEvent: async () => f.event,
  markReceiptProcessed: f.markReceipt,
}));
vi.mock("@/lib/realtime/realtime", () => ({ emitNewConversation: vi.fn() }));

import { handleSendFollowup } from "@/lib/jobs/handlers/send-followup";
import { handleProcessInboundMessage } from "@/lib/conversations/inbound";

const ctx: TenantContext = {
  businessId: "audit-business",
  role: null,
  actor: { kind: "system_job", jobId: "audit-job" },
  dataConnection: "shared-default",
};
const payload = {
  businessId: ctx.businessId,
  idempotencyKey: "audit-idempotency",
  channel: "audit_channel",
  connectionId: "audit-connection",
  to: "audit-recipient",
  message: "Audit follow-up",
  conversationId: "audit-conversation",
};

beforeEach(() => {
  vi.clearAllMocks();
  f.status = "scheduled";
  f.ops = {};
  f.receiptStatus = "enqueued";
  f.markReceipt.mockImplementation(async (_ctx, _id, status) => {
    f.receiptStatus = status;
  });
  f.chat.mockResolvedValue("R1 synthetic reply");
  f.send.mockResolvedValue({ success: true });
  f.messageCreate.mockReset().mockResolvedValue({ id: "audit-message" });
  f.actionUpdate.mockImplementation(async ({ data }) => {
    f.status = data.status;
    return { id: "audit-action", ...data };
  });
});

// Desired behavior for R1. These are deliberately red against the baseline;
// do not treat failure-path mocks as real-provider or durable-DB evidence.
describe("R1 delivery recovery contract", () => {
  it("does not resend an already-recorded successful follow-up", async () => {
    f.status = "succeeded";
    await handleSendFollowup(ctx, payload);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("does not resend after provider success followed by a message-write failure", async () => {
    f.messageCreate.mockRejectedValueOnce(new Error("Simulated post-send persistence failure"));
    await handleSendFollowup(ctx, payload).catch(() => undefined);
    expect(f.send).toHaveBeenCalledTimes(1);
    await handleSendFollowup(ctx, payload).catch(() => undefined);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("does not complete an inbound receipt as processed after send refusal", async () => {
    f.send.mockResolvedValue({
      success: false,
      outcome: "rejected",
      retryable: true,
      error: "Simulated provider refusal",
    });
    await handleProcessInboundMessage(ctx, {
      businessId: ctx.businessId,
      receiptId: "audit-receipt",
    }).catch(() => undefined);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.markReceipt).not.toHaveBeenCalledWith(ctx, "audit-receipt", "processed");
  });

  it("retries delivery using the completed response without repeating AI/tool computation", async () => {
    f.send.mockResolvedValueOnce({
      success: false,
      outcome: "rejected",
      retryable: true,
      error: "Simulated provider refusal",
    });
    const inboundPayload = { businessId: ctx.businessId, receiptId: "audit-receipt" };
    await handleProcessInboundMessage(ctx, inboundPayload).catch(() => undefined);
    await handleProcessInboundMessage(ctx, inboundPayload).catch(() => undefined);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.chat).toHaveBeenCalledTimes(1);
  });

  it("does not automatically repeat a send with an uncertain transport outcome", async () => {
    // The synthetic provider may have accepted the request before the connection
    // reset. A thrown error supplies no proof that nothing was sent.
    f.send.mockRejectedValueOnce(new Error("Connection reset after submission"));
    await handleSendFollowup(ctx, payload).catch(() => undefined);
    await handleSendFollowup(ctx, payload).catch(() => undefined);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch again on recovery of an interrupted in-flight send", async () => {
    // Inject a durable-state read; this is NOT a real worker-kill/DB test.
    f.status = "running";
    await handleSendFollowup(ctx, payload).catch(() => undefined);
    expect(f.send).not.toHaveBeenCalled();
  });
});
