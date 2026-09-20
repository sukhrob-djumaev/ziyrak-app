import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma/raw-client";
import type { TenantContext } from "@/lib/tenancy/context";
import { TEST_DEFAULT_BUSINESS_ID } from "../setup";

// Mock OpenAI
const mockOpenAICreateFn = vi.fn();
vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  class MockOpenAI {
    chat = {
      completions: {
        create: mockOpenAICreateFn,
      },
    };
  }
  return { ...actual, default: MockOpenAI };
});

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

// assertDefaultBusinessOnly() (mocked in tests/setup.ts) checks this
// against the also-mocked getDefaultBusinessId() — must match for chat()
// to proceed past its guard.
const ctx: TenantContext = {
  businessId: TEST_DEFAULT_BUSINESS_ID,
  role: "admin",
  actor: { kind: "user", userId: "test-user" },
  dataConnection: "shared-default",
};

describe("AI Engine", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    mockOpenAICreateFn.mockReset();

    // §46.4 — chat() now resolves AI provider/model/credential via
    // resolveAIConfig() (BusinessConfig, falling back to the legacy
    // Settings singleton for the Default Business per ai/config.ts's own
    // precedence) and business-profile fields via a separate
    // BusinessConfig upsert. No BusinessConfig row exists for this test's
    // business yet, so both fall through to the legacy Settings values
    // below — matching this suite's pre-Phase-4 fixture data exactly.
    mockPrisma.businessConfig.findUnique.mockResolvedValue(null);
    mockPrisma.businessConfig.upsert.mockResolvedValue({
      businessId: TEST_DEFAULT_BUSINESS_ID,
      businessName: "Test Biz",
      businessDesc: "A test business",
      welcomeMessage: "Hello!",
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
    mockPrisma.settings.upsert.mockResolvedValue({
      id: "default",
      businessName: "Test Biz",
      businessDesc: "A test business",
      welcomeMessage: "Hello!",
      tone: "friendly",
      language: "auto",
      aiProvider: "openai",
      aiModel: "gpt-4",
      aiApiKey: "sk-test",
      maxTokens: 1000,
      temperature: 0.7,
    });

    // Default knowledge base
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([]);

    // Default conversation
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: "conv-1",
      channel: "whatsapp",
      customerName: "John",
      customerContact: "+1555",
      status: "active",
      messages: [
        { role: "customer", content: "Hi", createdAt: new Date() },
      ],
    });

    // Default message creation
    mockPrisma.message.create.mockResolvedValue({ id: "msg-new" });
    mockPrisma.conversation.update.mockResolvedValue({});
  });

  it("should return fallback when AI API key is not configured", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({
      id: "default",
      aiApiKey: "",
      aiProvider: "openai",
      aiModel: "gpt-4",
      maxTokens: 1000,
      temperature: 0.7,
    });

    const { chat } = await import("@/lib/ai/engine");
    const response = await chat(ctx, "conv-1", "Hello");

    expect(response).toContain("AI is not configured");
  });

  it("should return error when conversation not found", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(null);

    const { chat } = await import("@/lib/ai/engine");
    const response = await chat(ctx, "nonexistent", "Hello");

    expect(response).toBe("Conversation not found.");
  });

  it("should call OpenAI with correct parameters", async () => {
    mockOpenAICreateFn.mockResolvedValue({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "Hello! How can I help?" },
        },
      ],
    });

    const { chat } = await import("@/lib/ai/engine");
    const response = await chat(ctx, "conv-1", "I need help");

    expect(response).toBe("Hello! How can I help?");
    expect(mockOpenAICreateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4",
        max_tokens: 1000,
        temperature: 0.7,
      })
    );
  });

  it("should save user and assistant messages", async () => {
    mockOpenAICreateFn.mockResolvedValue({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "I can help with that." },
        },
      ],
    });

    const { chat } = await import("@/lib/ai/engine");
    await chat(ctx, "conv-1", "Help me");

    // User message saved
    expect(mockPrisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: "conv-1",
          role: "customer",
          content: "Help me",
        }),
      })
    );

    // Assistant message saved
    expect(mockPrisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: "conv-1",
          role: "assistant",
          content: "I can help with that.",
        }),
      })
    );
  });

  it("should include knowledge base in system prompt", async () => {
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([
      {
        category: { name: "FAQ" },
        title: "Return Policy",
        content: "30-day returns allowed",
        priority: 10,
      },
    ]);

    mockOpenAICreateFn.mockResolvedValue({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "Our return policy..." },
        },
      ],
    });

    const { chat } = await import("@/lib/ai/engine");
    await chat(ctx, "conv-1", "What is your return policy?");

    const callArgs = mockOpenAICreateFn.mock.calls[0][0];
    const systemMessage = callArgs.messages[0];
    expect(systemMessage.content).toContain("Return Policy");
    expect(systemMessage.content).toContain("30-day returns allowed");
  });

  it("should handle tool calls and recurse", async () => {
    // First call returns tool_calls
    mockOpenAICreateFn
      .mockResolvedValueOnce({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "get_customer_history",
                    arguments: JSON.stringify({ customerContact: "+1555" }),
                  },
                },
              ],
            },
          },
        ],
      })
      // Second call returns final response
      .mockResolvedValueOnce({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Based on your history, I can see...",
            },
          },
        ],
      });

    // Mock the customer history tool
    mockPrisma.conversation.findMany.mockResolvedValue([]);

    const { chat } = await import("@/lib/ai/engine");
    const response = await chat(ctx, "conv-1", "Do you know me?");

    expect(response).toBe("Based on your history, I can see...");
    expect(mockOpenAICreateFn).toHaveBeenCalledTimes(2);
  });

  it("should return fallback message when content is empty", async () => {
    mockOpenAICreateFn.mockResolvedValue({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "" },
        },
      ],
    });

    const { chat } = await import("@/lib/ai/engine");
    const response = await chat(ctx, "conv-1", "Hello");

    expect(response).toContain("could not generate a response");
  });

  describe("§2.3/§46.4 regression: confidence scoring reflects a real tool call, not a hardcoded false", () => {
    // Both scenarios use a short (<50 char) response with an empty
    // knowledge base, so neither the response-length nor knowledge-base-size
    // confidence bonuses apply — isolating exactly the `hasToolCalls` bonus
    // this bug fix is about. Without it: score = 0.5 (escalates, < 0.6).
    // With it: score = 0.6 (does not escalate).
    it("escalates when no tool was used and the short response alone doesn't clear the confidence threshold", async () => {
      mockOpenAICreateFn.mockResolvedValue({
        choices: [{ finish_reason: "stop", message: { content: "OK." } }],
      });
      mockPrisma.conversation.update.mockClear();

      const { chat } = await import("@/lib/ai/engine");
      await chat(ctx, "conv-1", "Hello");

      expect(mockPrisma.conversation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "escalated" }) })
      );
    });

    it("does not escalate the same short response once a tool was actually used in the turn (the +0.1 bonus this bug fix restores)", async () => {
      mockOpenAICreateFn
        .mockResolvedValueOnce({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { name: "get_customer_history", arguments: JSON.stringify({ customerContact: "+1555" }) },
                  },
                ],
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          choices: [{ finish_reason: "stop", message: { content: "OK." } }],
        });
      mockPrisma.conversation.findMany.mockResolvedValue([]);
      mockPrisma.conversation.update.mockClear();

      const { chat } = await import("@/lib/ai/engine");
      await chat(ctx, "conv-1", "Do you know me?");

      expect(mockPrisma.conversation.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "escalated" }) })
      );
    });
  });

  describe("§46.4 task 5: checkBlockedTopics wired as a real pre-check", () => {
    it("redirects a blocked-topic message instead of calling the model at all", async () => {
      const { chat } = await import("@/lib/ai/engine");
      const response = await chat(ctx, "conv-1", "Can you give me legal advice about this contract?");

      expect(response).not.toContain("legal advice");
      expect(response.toLowerCase()).toContain("team member");
      expect(mockOpenAICreateFn).not.toHaveBeenCalled();

      // The customer's message is still recorded, plus the redirect itself.
      expect(mockPrisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ role: "customer", content: "Can you give me legal advice about this contract?" }) })
      );
      expect(mockPrisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ role: "assistant" }) })
      );
    });

    it("does not redirect an ordinary message that merely mentions an unrelated topic", async () => {
      mockOpenAICreateFn.mockResolvedValue({
        choices: [{ finish_reason: "stop", message: { content: "Sure, here is our shipping policy." } }],
      });

      const { chat } = await import("@/lib/ai/engine");
      const response = await chat(ctx, "conv-1", "What are your shipping rates?");

      expect(response).toBe("Sure, here is our shipping policy.");
      expect(mockOpenAICreateFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("§21.3: one bounded retry for a retryable provider error", () => {
    it("retries once on a retryable error (rate limit) and returns the retried success", async () => {
      const { RateLimitError } = await import("openai");
      mockOpenAICreateFn
        .mockRejectedValueOnce(new RateLimitError(429, {}, "Rate limited", new Headers()))
        .mockResolvedValueOnce({
          choices: [{ finish_reason: "stop", message: { content: "Recovered after retry." } }],
        });

      const { chat } = await import("@/lib/ai/engine");
      const response = await chat(ctx, "conv-1", "Hello");

      expect(response).toBe("Recovered after retry.");
      expect(mockOpenAICreateFn).toHaveBeenCalledTimes(2);
    });

    it("does not retry a non-retryable error (auth) and falls back to the existing user-facing message after one call", async () => {
      const { AuthenticationError } = await import("openai");
      mockOpenAICreateFn.mockRejectedValue(new AuthenticationError(401, {}, "Invalid API key", new Headers()));

      const { chat } = await import("@/lib/ai/engine");
      const response = await chat(ctx, "conv-1", "Hello");

      expect(response).toContain("temporarily unable to process your request");
      expect(mockOpenAICreateFn).toHaveBeenCalledTimes(1);
    });

    it("falls back to the existing user-facing message if the retry also fails", async () => {
      const { RateLimitError } = await import("openai");
      mockOpenAICreateFn.mockRejectedValue(new RateLimitError(429, {}, "Rate limited", new Headers()));

      const { chat } = await import("@/lib/ai/engine");
      const response = await chat(ctx, "conv-1", "Hello");

      expect(response).toContain("temporarily unable to process your request");
      expect(mockOpenAICreateFn).toHaveBeenCalledTimes(2);
    });
  });
});
