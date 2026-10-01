import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma/raw-client";
import type { TenantContext } from "@/lib/tenancy/context";
import { TEST_DEFAULT_BUSINESS_ID } from "../setup";

/**
 * chat() over a real AnthropicProvider (SDK transport mocked): the current
 * Claude models' thinking blocks survive the tool-call loop, and an
 * unsupported (retired) model fails honestly — fallback copy to the
 * customer, a reason in the operator log, no Anthropic call, no secret logged.
 */
const mockAnthropicCreateFn = vi.fn();
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class MockAnthropic {
    messages = { create: mockAnthropicCreateFn };
  }
  return { ...actual, default: MockAnthropic };
});

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

const ctx: TenantContext = {
  businessId: TEST_DEFAULT_BUSINESS_ID,
  role: "admin",
  actor: { kind: "user", userId: "test-user" },
  dataConnection: "shared-default",
};

function useLegacyAnthropicConfig(aiModel: string) {
  mockPrisma.settings.findUnique.mockResolvedValue({
    id: "default",
    aiProvider: "anthropic",
    aiModel,
    aiApiKey: "sk-ant-engine-test-key",
    maxTokens: 1000,
    temperature: 0.7,
  });
}

describe("chat() with AnthropicProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockAnthropicCreateFn.mockReset();
    mockPrisma.businessConfig.findUnique.mockResolvedValue(null);
    mockPrisma.businessConfig.upsert.mockResolvedValue({
      businessId: TEST_DEFAULT_BUSINESS_ID,
      businessName: "Test Biz",
      businessDesc: "A test business",
      welcomeMessage: "Hello!",
      tone: "friendly",
      language: "auto",
    });
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([]);
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: "conv-1",
      channel: "webchat",
      customerName: "Jo",
      customerContact: "visitor-1",
      status: "active",
      messages: [],
    });
    mockPrisma.message.create.mockResolvedValue({ id: "msg-new" });
    mockPrisma.conversation.update.mockResolvedValue({});
    mockPrisma.actionExecution.findUnique.mockResolvedValue(null);
    mockPrisma.actionExecution.create.mockResolvedValue({ id: "action-exec-1" });
    mockPrisma.actionExecution.update.mockResolvedValue({});
    mockPrisma.toolPolicy.findUnique.mockResolvedValue(null);
    mockPrisma.ticket.create.mockResolvedValue({ id: "ticket-1", title: "Broken scooter" });
  });

  it("passes the tool_use turn's thinking blocks back unchanged on the follow-up request", async () => {
    useLegacyAnthropicConfig("claude-sonnet-5-5");
    mockAnthropicCreateFn
      .mockResolvedValueOnce({
        content: [
          { type: "thinking", thinking: "", signature: "sig-engine" },
          { type: "tool_use", id: "toolu_e1", name: "create_ticket", input: { title: "Broken scooter", description: "Wheel" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 50, output_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "I've opened a ticket for your scooter." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 80, output_tokens: 12 },
      });

    const { chat } = await import("@/lib/ai/engine");
    const response = await chat(ctx, "conv-1", "My scooter is broken, please open a ticket");

    expect(response).toBe("I've opened a ticket for your scooter.");
    expect(mockAnthropicCreateFn).toHaveBeenCalledTimes(2);
    const followUp = mockAnthropicCreateFn.mock.calls[1][0];
    expect(followUp).not.toHaveProperty("temperature");
    const assistantTurn = followUp.messages.find((m: { role: string }) => m.role === "assistant");
    expect(assistantTurn.content[0]).toEqual({ type: "thinking", thinking: "", signature: "sig-engine" });
    expect(assistantTurn.content[1]).toMatchObject({ type: "tool_use", id: "toolu_e1", name: "create_ticket" });
  });

  it("a retired model never reaches Anthropic: fallback copy for the customer, reason logged without the key", async () => {
    useLegacyAnthropicConfig("claude-3-5-haiku-20241022");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { chat } = await import("@/lib/ai/engine");
    const response = await chat(ctx, "conv-1", "Hello");

    expect(response).toContain("temporarily unable to process your request");
    expect(mockAnthropicCreateFn).not.toHaveBeenCalled();
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("claude-3-5-haiku-20241022");
    expect(logged).toContain("invalid_request");
    expect(logged).not.toContain("sk-ant-engine-test-key");
  });
});
