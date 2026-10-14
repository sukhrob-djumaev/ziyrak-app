import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/lib/tenancy/context";

const f = vi.hoisted(() => ({
  status: "scheduled",
  send: vi.fn(),
  messageCreate: vi.fn(),
  actionUpdate: vi.fn(),
  markReceipt: vi.fn(),
  chat: vi.fn(),
  event: {
    type: "message.received",
    source: { channel: "audit_channel", connectionId: "audit-connection" },
    conversationId: "audit-conversation",
    payload: { text: "hello", customerContact: "audit-recipient", customerName: "Audit" },
  },
}));
vi.mock("@/lib/tenancy/scoped-prisma", () => ({
  getScopedPrisma: () => ({
    actionExecution: {
      findUnique: async () => ({ id: "audit-action", status: f.status }),
      update: f.actionUpdate,
    },
    message: { create: f.messageCreate },
  }),
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
    f.send.mockResolvedValue({ success: false, error: "Simulated provider refusal" });
    await handleProcessInboundMessage(ctx, {
      businessId: ctx.businessId,
      receiptId: "audit-receipt",
    }).catch(() => undefined);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.markReceipt).not.toHaveBeenCalledWith(ctx, "audit-receipt", "processed");
  });

  it("retries delivery using the completed response without repeating AI/tool computation", async () => {
    f.send.mockResolvedValueOnce({ success: false, error: "Simulated provider refusal" });
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
