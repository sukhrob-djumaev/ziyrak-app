import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma/raw-client";
import { TEST_DEFAULT_BUSINESS_ID } from "../setup";

/**
 * PLAN.md §2.5/§20.2/§46.5 — regression test for the `whatsappClient`
 * assignment race: the residual bug (fixed as part of this phase) assigned
 * `whatsappClient = client` only after `client.initialize()`'s own promise
 * resolved. whatsapp-web.js can fire `"ready"` before that promise settles
 * — this test controls the mock's event emission order to reproduce
 * exactly that ordering and asserts `sendWhatsAppMessage` no longer
 * no-ops on a message that arrives once the session is genuinely ready.
 */

type Handler = (...args: unknown[]) => unknown;
const handlers: Record<string, Handler> = {};
const sendMessageSpy = vi.fn().mockResolvedValue(undefined);

let resolveInitialize!: () => void;

vi.mock("whatsapp-web.js", () => {
  class MockClient {
    on(event: string, handler: Handler) {
      handlers[event] = handler;
    }
    initialize() {
      // Deliberately never resolves until the test says so — this is what
      // lets the test fire "ready" strictly *before* initialize()'s own
      // promise settles, reproducing the exact race §2.5 identified.
      return new Promise<void>((resolve) => {
        resolveInitialize = resolve;
      });
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

vi.mock("qrcode", () => ({ toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,fake") }));

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

describe("WhatsApp Web client-assignment race regression (§2.5/§20.2)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sendMessageSpy.mockClear();
    for (const model of Object.values(mockPrisma)) {
      if (typeof model !== "object" || model === null) continue;
      for (const method of Object.values(model)) {
        if (typeof method === "function" && "mockReset" in method) {
          (method as ReturnType<typeof vi.fn>).mockReset();
        }
      }
    }
    mockPrisma.channelConnection.update.mockResolvedValue({});
  });

  it("sendWhatsAppMessage succeeds once 'ready' fires, even before initialize()'s own promise has resolved", async () => {
    const { initWhatsApp, sendWhatsAppMessage } = await import("@/lib/channels/whatsapp");

    const ctx = {
      businessId: TEST_DEFAULT_BUSINESS_ID,
      role: "owner",
      actor: { kind: "user" as const, userId: "test-owner" },
      dataConnection: "shared-default",
    };

    // Do not await — initialize() is deliberately unresolved at this point.
    const initPromise = initWhatsApp(ctx, "whatsapp-conn-1");

    const readyHandler = handlers["ready"];
    expect(readyHandler).toBeTypeOf("function");
    await readyHandler();

    // The bug this regresses: if `whatsappClient` were only assigned after
    // `client.initialize()` resolves (which we're deliberately blocking),
    // this would incorrectly return false — a message that arrived after
    // the session came online would be silently dropped.
    const sent = await sendWhatsAppMessage("15550001234@c.us", "Thanks for reaching out!");
    expect(sent).toBe(true);
    expect(sendMessageSpy).toHaveBeenCalledWith("15550001234@c.us", "Thanks for reaching out!");

    resolveInitialize();
    await initPromise;
  });
});
