import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import { createRequest, parseJsonResponse } from "../helpers/request";

// Restore the real requireAuth/isAuthenticated implementation for this file.
// tests/setup.ts mocks route-auth globally to always authenticate as admin,
// which would hide the exact bug this suite exists to catch.
vi.mock("@/lib/route-auth", async (importOriginal) => {
  return importOriginal();
});

vi.mock("@/lib/ai/engine", () => ({
  chat: vi.fn().mockResolvedValue("should not be reached"),
  createNewConversation: vi.fn().mockResolvedValue({ id: "should-not-be-reached" }),
}));

vi.mock("@/lib/channels/whatsapp", () => ({
  getWhatsAppStatus: vi.fn().mockReturnValue({ status: "disconnected", qr: null, message: "" }),
  initWhatsApp: vi.fn().mockResolvedValue(undefined),
  disconnectWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/channels/email", () => ({
  getEmailStatus: vi.fn().mockReturnValue({ status: "disconnected" }),
  startEmailListener: vi.fn().mockResolvedValue(undefined),
  stopEmailListener: vi.fn().mockResolvedValue(undefined),
}));

const WRONG_SECRET = "attacker-controlled-secret";

/** A 3-part, structurally valid JWT signed with the wrong secret. */
function forgedToken(): string {
  return jwt.sign({ userId: "admin-1", role: "admin" }, WRONG_SECRET, { expiresIn: "7d" });
}

describe("Auth bypass regression (§2.2 / §46.0)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const cases: Array<{
    name: string;
    method: "GET" | "POST";
    path: string;
    body?: Record<string, unknown>;
  }> = [
    { name: "POST /api/chat", method: "POST", path: "/api/chat", body: { message: "hi" } },
    { name: "GET /api/realtime", method: "GET", path: "/api/realtime" },
    { name: "GET /api/channels/whatsapp", method: "GET", path: "/api/channels/whatsapp" },
    { name: "POST /api/channels/whatsapp", method: "POST", path: "/api/channels/whatsapp", body: { action: "connect" } },
    { name: "GET /api/channels/email", method: "GET", path: "/api/channels/email" },
    { name: "POST /api/channels/email", method: "POST", path: "/api/channels/email", body: { action: "connect" } },
    { name: "POST /api/webhooks/test", method: "POST", path: "/api/webhooks/test", body: { webhookId: "wh-1" } },
  ];

  async function loadHandler(path: string, method: "GET" | "POST") {
    switch (path) {
      case "/api/chat":
        return (await import("@/app/api/chat/route"))[method];
      case "/api/realtime":
        return (await import("@/app/api/realtime/route"))[method];
      case "/api/channels/whatsapp":
        return (await import("@/app/api/channels/whatsapp/route"))[method];
      case "/api/channels/email":
        return (await import("@/app/api/channels/email/route"))[method];
      case "/api/webhooks/test":
        return (await import("@/app/api/webhooks/test/route"))[method];
      default:
        throw new Error(`no handler mapped for ${path}`);
    }
  }

  describe.each(cases)("$name", ({ method, path, body }) => {
    it("rejects a request with no credentials", async () => {
      const handler = await loadHandler(path, method);
      const request = createRequest(path, { method, body });
      const response = await handler(request);

      expect(response.status).toBe(401);
    });

    it("rejects a garbage (non-JWT) cookie", async () => {
      const handler = await loadHandler(path, method);
      const request = createRequest(path, {
        method,
        body,
        cookies: { "owly-token": "not-a-real-token" },
      });
      const response = await handler(request);

      expect(response.status).toBe(401);
    });

    it("rejects a structurally valid JWT signed with the wrong secret", async () => {
      const handler = await loadHandler(path, method);
      const request = createRequest(path, {
        method,
        body,
        cookies: { "owly-token": forgedToken() },
      });
      const response = await handler(request);

      expect(response.status).toBe(401);
      const data = await parseJsonResponse(response);
      expect(data.error?.code).toBe("INVALID_TOKEN");
    });
  });

  it("never reaches the AI engine when /api/chat is called without auth", async () => {
    const { chat, createNewConversation } = await import("@/lib/ai/engine");
    const { POST } = await import("@/app/api/chat/route");

    const request = createRequest("/api/chat", { method: "POST", body: { message: "hi" } });
    await POST(request);

    expect(createNewConversation).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it("never touches the WhatsApp client when /api/channels/whatsapp is called without auth", async () => {
    const { initWhatsApp, disconnectWhatsApp } = await import("@/lib/channels/whatsapp");
    const { POST } = await import("@/app/api/channels/whatsapp/route");

    const request = createRequest("/api/channels/whatsapp", {
      method: "POST",
      body: { action: "disconnect" },
    });
    await POST(request);

    expect(initWhatsApp).not.toHaveBeenCalled();
    expect(disconnectWhatsApp).not.toHaveBeenCalled();
  });
});
