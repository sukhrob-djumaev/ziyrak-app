import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma/raw-client";
import { createRequest, parseJsonResponse } from "../helpers/request";

/**
 * Characterization suite (§46.0): pins today's single-tenant /api/chat
 * behavior so Phase 1's migration can be verified against it. Not testing
 * new behavior — just recording what the app does today.
 */

const mockOpenAICreateFn = vi.fn();
vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockOpenAICreateFn } };
  },
}));

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

describe("Characterization: POST /api/chat creates a conversation and persists messages", () => {
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

    mockPrisma.conversation.create.mockResolvedValue({
      id: "conv-char-1",
      channel: "api",
      customerName: "API User",
      customerContact: "",
    });

    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: "conv-char-1",
      channel: "api",
      customerName: "API User",
      customerContact: "",
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
      choices: [{ finish_reason: "stop", message: { content: "Hello! How can I help you today?" } }],
    });
  });

  it("creates a new conversation when no conversationId is given", async () => {
    const { POST } = await import("@/app/api/chat/route");
    const request = createRequest("/api/chat", {
      method: "POST",
      body: { message: "Hi there" },
    });

    const response = await POST(request);
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.conversationId).toBe("conv-char-1");
    expect(mockPrisma.conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ channel: "api" }),
      })
    );
  });

  it("persists the customer message and the assistant reply as Message rows", async () => {
    const { POST } = await import("@/app/api/chat/route");
    const request = createRequest("/api/chat", {
      method: "POST",
      body: { message: "I need help with my order" },
    });

    await POST(request);

    expect(mockPrisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: "conv-char-1",
          role: "customer",
          content: "I need help with my order",
        }),
      })
    );

    expect(mockPrisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: "conv-char-1",
          role: "assistant",
          content: "Hello! How can I help you today?",
        }),
      })
    );
  });

  it("returns the AI-generated response body", async () => {
    const { POST } = await import("@/app/api/chat/route");
    const request = createRequest("/api/chat", {
      method: "POST",
      body: { message: "Hi" },
    });

    const response = await POST(request);
    const data = await parseJsonResponse(response);

    expect(data.response).toBe("Hello! How can I help you today?");
  });
});
