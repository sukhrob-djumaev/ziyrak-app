import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma/raw-client";
import { TEST_DEFAULT_BUSINESS_ID } from "../setup";
import type { FakeJobQueue } from "@/lib/jobs/fake-job-queue";

/**
 * Characterization suite (§46.0): pins today's single-tenant WhatsApp
 * inbound-message behavior (customer resolution, conversation creation, AI
 * reply persistence and delivery) so each phase's migration can be verified
 * against it. The 'message' handler is invoked directly against a mocked
 * whatsapp-web.js client, not through real Puppeteer.
 *
 * PLAN.md §46.5 — updated for the Phase 5 migration: `initWhatsApp` now
 * takes an explicit `(ctx, connectionId)` instead of resolving the Default
 * Business implicitly, and the message handler dedupes/enqueues through the
 * shared `InboundEventReceipt`/`JobQueue` pipeline instead of calling
 * `chat()` inline — so this test fires the real (fake) job queue's handler
 * and awaits it draining before asserting on the same observable behavior
 * as before (customer resolved, conversation created, both messages
 * persisted, reply delivered over WhatsApp). The reply itself is now sent
 * via `WhatsAppWebAdapter.sendMessage()` → the client's own `sendMessage()`
 * (§19.1's generic contract) rather than the inbound message's own
 * `.reply()` — a deliberate consolidation (every channel now replies
 * through one `ChannelAdapter.sendMessage` shape), not a behavior
 * regression: the customer still receives the same AI-generated text over
 * the same WhatsApp chat.
 */

type Handler = (...args: unknown[]) => unknown;
const handlers: Record<string, Handler> = {};
const sendMessageSpy = vi.fn().mockResolvedValue(undefined);

vi.mock("whatsapp-web.js", () => {
  class MockClient {
    on(event: string, handler: Handler) {
      handlers[event] = handler;
    }
    initialize() {
      return Promise.resolve();
    }
    destroy() {
      return Promise.resolve();
    }
    sendMessage(...args: unknown[]) {
      return sendMessageSpy(...args);
    }
  }
  class MockLocalAuth {}
  return { Client: MockClient, LocalAuth: MockLocalAuth };
});

vi.mock("qrcode", () => ({
  toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,fake"),
}));

const mockOpenAICreateFn = vi.fn();
vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockOpenAICreateFn } };
  },
}));

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

const TEST_CONNECTION_ID = "whatsapp-conn-1";
const testCtx = {
  businessId: TEST_DEFAULT_BUSINESS_ID,
  role: "owner",
  actor: { kind: "user" as const, userId: "test-owner" },
  dataConnection: "shared-default",
};

describe("Characterization: WhatsApp inbound message flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockOpenAICreateFn.mockReset();
    sendMessageSpy.mockClear();
    for (const model of Object.values(mockPrisma)) {
      if (typeof model !== "object" || model === null) continue;
      for (const method of Object.values(model)) {
        if (typeof method === "function" && "mockReset" in method) {
          (method as ReturnType<typeof vi.fn>).mockReset();
        }
      }
    }

    mockPrisma.customer.findFirst.mockResolvedValue(null);
    mockPrisma.customer.create.mockResolvedValue({ id: "cust-new" });
    mockPrisma.conversation.findFirst.mockResolvedValue(null);
    mockPrisma.conversation.create.mockResolvedValue({
      id: "conv-new",
      channel: "whatsapp",
      customerName: "Jane Customer",
      customerContact: "15550001234@c.us",
    });
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: "conv-new",
      channel: "whatsapp",
      customerName: "Jane Customer",
      customerContact: "15550001234@c.us",
      messages: [],
    });
    // §46.4 — chat() now resolves config via resolveAIConfig()/
    // resolveConversationProfile() (BusinessConfig, falling back to the
    // legacy Settings singleton for the Default Business).
    mockPrisma.businessConfig.findUnique.mockResolvedValue(null);
    mockPrisma.businessConfig.upsert.mockResolvedValue({
      businessId: TEST_DEFAULT_BUSINESS_ID,
      businessName: "Test Biz",
      businessDesc: "",
      welcomeMessage: "",
      tone: "friendly",
      language: "auto",
    });
    mockPrisma.settings.findUnique.mockResolvedValue({
      id: "default",
      aiProvider: "openai",
      aiModel: "gpt-4",
      aiApiKey: "sk-test",
      maxTokens: 1000,
      temperature: 0.7,
    });
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([]);
    mockPrisma.message.create.mockResolvedValue({ id: "msg-generated" });
    mockPrisma.conversation.update.mockResolvedValue({});
    // §46.6 task 6 — processInboundMessage() now also evaluates automation
    // rules before calling chat(); no rules configured for this suite.
    mockPrisma.automationRule.findMany.mockResolvedValue([]);

    // §46.5 — dedup receipt persistence and job-context tenant resolution.
    // The job handler reloads the persisted event by receiptId
    // (loadReceiptEvent → findUniqueOrThrow) — the mock echoes back
    // whatever `create` was called with, matching real Postgres behavior.
    let createdReceipt: Record<string, unknown> = {};
    mockPrisma.inboundEventReceipt.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      createdReceipt = { id: "receipt-1", ...args.data };
      return createdReceipt;
    });
    mockPrisma.inboundEventReceipt.findUniqueOrThrow.mockImplementation(async () => createdReceipt);
    mockPrisma.inboundEventReceipt.update.mockResolvedValue({});
    mockPrisma.tenantPlacement.findUnique.mockResolvedValue({
      businessId: TEST_DEFAULT_BUSINESS_ID,
      databaseProfileId: "shared-default",
    });

    mockOpenAICreateFn.mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: "Thanks for reaching out! How can I help?" } }],
    });
  });

  it("resolves the customer, creates a conversation, persists messages, and replies on WhatsApp", async () => {
    const { initWhatsApp } = await import("@/lib/channels/whatsapp");
    await initWhatsApp(testCtx, TEST_CONNECTION_ID);

    const readyHandler = handlers["ready"];
    expect(readyHandler).toBeTypeOf("function");
    await readyHandler();

    const messageHandler = handlers["message"];
    expect(messageHandler).toBeTypeOf("function");

    const fakeMessage = {
      fromMe: false,
      timestamp: Math.floor(Date.now() / 1000),
      from: "15550001234@c.us",
      body: "Hi, I need help with my order",
      hasMedia: false,
      id: { _serialized: "wa-msg-1" },
      getContact: vi.fn().mockResolvedValue({ pushname: "Jane Customer", name: "Jane" }),
    };

    await messageHandler(fakeMessage);

    // §46.5 — the message handler only dedupes+enqueues synchronously; the
    // actual processing runs on the (fake, in-process) job queue.
    const { jobQueue } = await import("@/lib/jobs/queue");
    await (jobQueue as unknown as FakeJobQueue).__drainForTests();

    // Customer identity resolution (§customer-resolver.ts)
    expect(mockPrisma.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ whatsapp: "15550001234@c.us" }),
      })
    );

    // Conversation created for the new customer
    expect(mockPrisma.conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          channel: "whatsapp",
          customerContact: "15550001234@c.us",
        }),
      })
    );

    // Both the inbound customer message and the AI reply are persisted
    expect(mockPrisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: "customer",
          content: "Hi, I need help with my order",
        }),
      })
    );
    expect(mockPrisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: "assistant" }),
      })
    );

    // AI reply delivered back over WhatsApp via the client's own sendMessage
    // (WhatsAppWebAdapter.sendMessage → sendWhatsAppMessage, §19.1).
    expect(sendMessageSpy).toHaveBeenCalledWith("15550001234@c.us", "Thanks for reaching out! How can I help?");
  });
});
