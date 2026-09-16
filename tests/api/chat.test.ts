import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseJsonResponse } from "../helpers/request";

vi.mock("@/lib/ai/engine", () => ({
  chat: vi.fn().mockResolvedValue("AI response here"),
  createNewConversation: vi.fn().mockResolvedValue({ id: "new-conv-1" }),
}));

describe("POST /api/chat", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should return AI response for valid message", async () => {
    const { chat, createNewConversation } = await import("@/lib/ai/engine");
    (chat as ReturnType<typeof vi.fn>).mockResolvedValue("Hello! How can I help?");
    (createNewConversation as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "conv-new" });

    const { POST } = await import("@/app/api/chat/route");
    const request = createRequest("/api/chat", {
      method: "POST",
      body: { message: "Hello" },
    });

    const response = await POST(request);
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.conversationId).toBe("conv-new");
    expect(data.response).toBe("Hello! How can I help?");
  });

  it("should reject empty message", async () => {
    const { POST } = await import("@/app/api/chat/route");
    const request = createRequest("/api/chat", {
      method: "POST",
      body: { message: "" },
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("should reject missing message", async () => {
    const { POST } = await import("@/app/api/chat/route");
    const request = createRequest("/api/chat", {
      method: "POST",
      body: {},
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("should reject message exceeding 10000 characters", async () => {
    const { POST } = await import("@/app/api/chat/route");
    const request = createRequest("/api/chat", {
      method: "POST",
      body: { message: "A".repeat(10001) },
    });

    const response = await POST(request);
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(400);
    expect(data.error).toContain("10000");
  });

  it("should use provided conversationId", async () => {
    const { chat } = await import("@/lib/ai/engine");
    (chat as ReturnType<typeof vi.fn>).mockResolvedValue("Response");

    const { POST } = await import("@/app/api/chat/route");
    const request = createRequest("/api/chat", {
      method: "POST",
      body: { message: "Hello", conversationId: "existing-conv" },
    });

    const response = await POST(request);
    const data = await parseJsonResponse(response);

    expect(data.conversationId).toBe("existing-conv");
    expect(chat).toHaveBeenCalledWith("existing-conv", "Hello");
  });

  it("should handle AI engine errors gracefully", async () => {
    const { chat, createNewConversation } = await import("@/lib/ai/engine");
    (createNewConversation as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "conv-err" });
    (chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("OpenAI unavailable"));

    const { POST } = await import("@/app/api/chat/route");
    const request = createRequest("/api/chat", {
      method: "POST",
      body: { message: "Hello" },
    });

    const response = await POST(request);
    expect(response.status).toBe(500);
  });
});
