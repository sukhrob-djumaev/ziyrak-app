import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma/raw-client";
import { createRequest, parseJsonResponse } from "../helpers/request";

/**
 * PLAN.md §32.1/§46.6 — `POST /api/webhooks/test` was the third call site
 * §32's own security table named alongside `trigger_webhook` and
 * `webhook-delivery.ts` as making a raw, unprotected `fetch()` against an
 * admin-configured URL. Mocked here the same way `tests/unit/ai-tools.test.ts`
 * mocks `trigger_webhook`'s dispatcher use — this route's own wiring is
 * what's under test, not the dispatcher's SSRF logic itself (that's
 * `tests/security/http-dispatcher-ssrf.test.ts`'s job).
 */
vi.mock("@/lib/integrations/http-dispatcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/http-dispatcher")>();
  return { ...actual, dispatchHttpRequest: vi.fn() };
});

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

describe("POST /api/webhooks/test", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    for (const model of Object.values(mockPrisma)) {
      if (typeof model !== "object" || model === null) continue;
      for (const method of Object.values(model)) {
        if (typeof method === "function" && "mockReset" in method) {
          (method as ReturnType<typeof vi.fn>).mockReset();
        }
      }
    }
  });

  it("dispatches the test payload through the shared SSRF-hardened dispatcher, not a raw fetch", async () => {
    mockPrisma.webhook.findUnique.mockResolvedValue({
      id: "wh-1",
      name: "Test hook",
      url: "https://example.test/hook",
      method: "POST",
      headers: {},
      triggerOn: "ticket_created",
    });

    const { dispatchHttpRequest } = await import("@/lib/integrations/http-dispatcher");
    vi.mocked(dispatchHttpRequest).mockResolvedValue({ ok: true, status: 200, statusText: "OK", body: "thanks" });

    const { POST } = await import("@/app/api/webhooks/test/route");
    const response = await POST(createRequest("/api/webhooks/test", { method: "POST", body: { webhookId: "wh-1" } }));
    const data = await parseJsonResponse(response);

    expect(dispatchHttpRequest).toHaveBeenCalledWith(
      "https://example.test/hook",
      expect.objectContaining({ method: "POST", includeResponseBody: true })
    );
    expect(data.success).toBe(true);
    expect(data.bodyPreview).toBe("thanks");
  });

  it("reports an SSRF rejection as a normal 500 response, not an unhandled crash", async () => {
    mockPrisma.webhook.findUnique.mockResolvedValue({
      id: "wh-2",
      name: "Internal hook",
      url: "http://169.254.169.254/latest/meta-data/",
      method: "POST",
      headers: {},
      triggerOn: "ticket_created",
    });

    const { dispatchHttpRequest, SSRFBlockedError } = await import("@/lib/integrations/http-dispatcher");
    vi.mocked(dispatchHttpRequest).mockRejectedValue(new SSRFBlockedError("http://169.254.169.254/", "resolves to a disallowed address"));

    const { POST } = await import("@/app/api/webhooks/test/route");
    const response = await POST(createRequest("/api/webhooks/test", { method: "POST", body: { webhookId: "wh-2" } }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.error).toContain("Refusing to dispatch");
  });
});
