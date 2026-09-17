import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma/raw-client";

/**
 * Characterization suite (§46.0): pins today's single-tenant WhatsApp
 * inbound-message behavior (customer resolution, conversation creation,
 * AI reply persistence and delivery) so Phase 1's migration can be
 * verified against it. The 'message' handler is invoked directly against
 * a mocked whatsapp-web.js client, not through real Puppeteer.
 */

type Handler = (...args: unknown[]) => unknown;
const handlers: Record<string, Handler> = {};

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

describe("Characterization: WhatsApp inbound message flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockOpenAICreateFn.mockReset();
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
    mockPrisma.settings.upsert.mockResolvedValue({
      id: "default",
      aiProvider: "openai",
      aiModel: "gpt-4",
      aiApiKey: "sk-test",
      maxTokens: 1000,
      temperature: 0.7,
      businessName: "Test Biz",
      businessDesc: "",
      welcomeMessage: "",
      tone: "friendly",
      language: "auto",
    });
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([]);
    mockPrisma.message.create.mockResolvedValue({ id: "msg-generated" });
    mockPrisma.conversation.update.mockResolvedValue({});

    mockOpenAICreateFn.mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: "Thanks for reaching out! How can I help?" } }],
    });
  });

  it("resolves the customer, creates a conversation, persists messages, and replies on WhatsApp", async () => {
    const { initWhatsApp } = await import("@/lib/channels/whatsapp");
    await initWhatsApp();

    const messageHandler = handlers["message"];
    expect(messageHandler).toBeTypeOf("function");

    const replyFn = vi.fn().mockResolvedValue(undefined);
    const fakeMessage = {
      fromMe: false,
      timestamp: Math.floor(Date.now() / 1000),
      from: "15550001234@c.us",
      body: "Hi, I need help with my order",
      hasMedia: false,
      getContact: vi.fn().mockResolvedValue({ pushname: "Jane Customer", name: "Jane" }),
      reply: replyFn,
    };

    await messageHandler(fakeMessage);

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

    // AI reply delivered back over WhatsApp
    expect(replyFn).toHaveBeenCalledWith("Thanks for reaching out! How can I help?");
  });
});
