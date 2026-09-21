import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma/raw-client";

/**
 * PLAN.md §34.1/§46.5 — the shared `ChannelAdapter` contract test suite,
 * run against all six adapters (five migrated + Web Chat). Per §19.1's own
 * revised shape, `validateInbound`'s *input* type is legitimately
 * different per adapter (an HTTP webhook body vs. a whatsapp-web.js
 * `Message` vs. a `mailparser` `ParsedMail`) — what's actually shared, and
 * what this suite checks, is: the capability/identity shape, that every
 * method the interface names exists, and that an unresolvable/invalid
 * input always comes back as `{kind: "rejected"}` rather than throwing.
 */

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

beforeEach(() => {
  for (const model of Object.values(mockPrisma)) {
    if (typeof model !== "object" || model === null) continue;
    for (const method of Object.values(model)) {
      if (typeof method === "function" && "mockReset" in method) {
        (method as ReturnType<typeof vi.fn>).mockReset();
      }
    }
  }
  // No ChannelConnection ever matches in this suite — every adapter's
  // validateInbound() should reject cleanly rather than throw.
  mockPrisma.channelConnection.findFirst.mockResolvedValue(null);
  mockPrisma.channelConnection.findUnique.mockResolvedValue(null);
});

async function loadAdapters() {
  const { smsAdapter } = await import("@/lib/channels/sms-adapter");
  const { telegramAdapter } = await import("@/lib/channels/telegram-adapter");
  const { phoneAdapter } = await import("@/lib/channels/phone-adapter");
  const { emailAdapter } = await import("@/lib/channels/email");
  const { whatsAppWebAdapter } = await import("@/lib/channels/whatsapp");
  const { webChatAdapter } = await import("@/lib/channels/webchat-adapter");
  const { metaCloudWhatsAppAdapter } = await import("@/lib/channels/meta-whatsapp-adapter");
  return { smsAdapter, telegramAdapter, phoneAdapter, emailAdapter, whatsAppWebAdapter, webChatAdapter, metaCloudWhatsAppAdapter };
}

describe("ChannelAdapter contract (§19.1/§34.1)", () => {
  it("every adapter exposes the required identity/capability/method shape", async () => {
    const adapters = await loadAdapters();

    for (const [name, adapter] of Object.entries(adapters)) {
      expect(typeof adapter.type, `${name}.type`).toBe("string");
      expect(adapter.type.length, `${name}.type non-empty`).toBeGreaterThan(0);

      const caps = adapter.capabilities;
      for (const key of [
        "supportsMedia",
        "supportsTemplates",
        "supportsTypingIndicator",
        "supportsDeliveryReceipts",
        "supportsMultipleConnections",
      ] as const) {
        expect(typeof caps[key], `${name}.capabilities.${key}`).toBe("boolean");
      }

      expect(typeof adapter.validateInbound, `${name}.validateInbound`).toBe("function");
      expect(typeof adapter.sendMessage, `${name}.sendMessage`).toBe("function");
      expect(typeof adapter.getStatus, `${name}.getStatus`).toBe("function");
    }
  });

  it("SmsAdapter rejects a request with no matching ChannelConnection instead of throwing", async () => {
    const { smsAdapter } = await loadAdapters();
    const result = await smsAdapter.validateInbound({
      headers: {},
      routeParams: {},
      formParams: { To: "+15550000000", From: "+15551234567", Body: "hi", MessageSid: "SM123" },
      url: "https://example.com/api/channels/sms",
    });
    expect(result.kind).toBe("rejected");
  });

  it("TelegramAdapter rejects a request with no matching connectionId instead of throwing", async () => {
    const { telegramAdapter } = await loadAdapters();
    const result = await telegramAdapter.validateInbound({
      headers: {},
      routeParams: { connectionId: "nonexistent" },
      json: { update_id: 1, message: { message_id: 1, from: { id: 1, first_name: "A" }, chat: { id: 1, type: "private" }, text: "hi", date: 0 } },
      url: "https://example.com/api/channels/telegram/nonexistent",
    });
    expect(result.kind).toBe("rejected");
  });

  it("PhoneAdapter rejects a request with no matching ChannelConnection instead of throwing", async () => {
    const { phoneAdapter } = await loadAdapters();
    const result = await phoneAdapter.validateInbound({
      headers: {},
      routeParams: {},
      formParams: { To: "+15550000000", From: "+15551234567", SpeechResult: "hi", CallSid: "CA123" },
      url: "https://example.com/api/channels/phone/gather",
    });
    expect(result.kind).toBe("rejected");
  });

  it("WebChatAdapter rejects a request with no matching connectionId instead of throwing", async () => {
    const { webChatAdapter } = await loadAdapters();
    const result = await webChatAdapter.validateInbound({
      headers: { origin: "https://example.com" },
      routeParams: { connectionId: "nonexistent" },
      json: { token: "zy_pub_x", clientMessageId: "m1", conversationId: "c1", text: "hi" },
      url: "https://example.com/api/channels/webchat/nonexistent/message",
    });
    expect(result.kind).toBe("rejected");
  });

  it("EmailAdapter rejects when there is no active listener session", async () => {
    const { emailAdapter } = await loadAdapters();
    const result = await emailAdapter.validateInbound({
      from: [{ address: "a@example.com", name: "A" }],
      value: [{ address: "a@example.com", name: "A" }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(result.kind).toBe("rejected");
  });

  it("WhatsAppWebAdapter rejects when there is no active session", async () => {
    const { whatsAppWebAdapter } = await loadAdapters();
    const result = await whatsAppWebAdapter.validateInbound({
      fromMe: false,
      timestamp: 0,
      from: "155501234@c.us",
      body: "hi",
      hasMedia: false,
      getContact: vi.fn().mockResolvedValue({ pushname: "X" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(result.kind).toBe("rejected");
  });

  it("MetaCloudWhatsAppAdapter rejects a request with an invalid signature instead of throwing", async () => {
    const { metaCloudWhatsAppAdapter } = await loadAdapters();
    const previous = process.env.META_APP_SECRET;
    process.env.META_APP_SECRET = "test-app-secret";
    try {
      const result = await metaCloudWhatsAppAdapter.validateInbound({
        headers: { "x-hub-signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000" },
        rawBody: JSON.stringify({ object: "whatsapp_business_account", entry: [] }),
      });
      expect(result.kind).toBe("rejected");
    } finally {
      process.env.META_APP_SECRET = previous;
    }
  });
});
