import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import { prisma } from "@/lib/prisma/raw-client";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

function sign(appSecret: string, rawBody: string): string {
  return `sha256=${crypto.createHmac("sha256", appSecret).update(rawBody, "utf-8").digest("hex")}`;
}

beforeEach(() => {
  for (const model of Object.values(mockPrisma)) {
    if (typeof model !== "object" || model === null) continue;
    for (const method of Object.values(model)) {
      if (typeof method === "function" && "mockReset" in method) {
        (method as ReturnType<typeof vi.fn>).mockReset();
      }
    }
  }
  process.env.META_APP_SECRET = "unit-test-app-secret";
});

describe("MetaCloudWhatsAppAdapter.validateInbound (§20.2/§46.7)", () => {
  it("rejects (not throws) when META_APP_SECRET is not configured on this deployment", async () => {
    delete process.env.META_APP_SECRET;
    const { metaCloudWhatsAppAdapter } = await import("@/lib/channels/meta-whatsapp-adapter");

    const result = await metaCloudWhatsAppAdapter.validateInbound({ headers: {}, rawBody: "{}" });
    expect(result.kind).toBe("rejected");
  });

  it("rejects an invalid X-Hub-Signature-256 before any database lookup", async () => {
    const { metaCloudWhatsAppAdapter } = await import("@/lib/channels/meta-whatsapp-adapter");
    const rawBody = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

    const result = await metaCloudWhatsAppAdapter.validateInbound({
      headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64) },
      rawBody,
    });

    expect(result.kind).toBe("rejected");
    expect(mockPrisma.channelConnection.findFirst).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON without throwing", async () => {
    const { metaCloudWhatsAppAdapter } = await import("@/lib/channels/meta-whatsapp-adapter");
    const rawBody = "{not valid json";
    const result = await metaCloudWhatsAppAdapter.validateInbound({
      headers: { "x-hub-signature-256": sign("unit-test-app-secret", rawBody) },
      rawBody,
    });
    expect(result.kind).toBe("rejected");
  });

  it("rejects a status-callback payload (no inbound text message) without throwing", async () => {
    const { metaCloudWhatsAppAdapter } = await import("@/lib/channels/meta-whatsapp-adapter");
    const rawBody = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [{ field: "messages", value: { statuses: [{ id: "wamid.1", status: "delivered" }] } }] }],
    });
    const result = await metaCloudWhatsAppAdapter.validateInbound({
      headers: { "x-hub-signature-256": sign("unit-test-app-secret", rawBody) },
      rawBody,
    });
    expect(result.kind).toBe("rejected");
  });

  it("rejects when no ChannelConnection matches the payload's phone_number_id", async () => {
    mockPrisma.channelConnection.findFirst.mockResolvedValue(null);
    const { metaCloudWhatsAppAdapter } = await import("@/lib/channels/meta-whatsapp-adapter");
    const rawBody = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "unknown-phone-number-id" },
                messages: [{ from: "15551234567", id: "wamid.abc", timestamp: "1700000000", type: "text", text: { body: "hi" } }],
              },
            },
          ],
        },
      ],
    });

    const result = await metaCloudWhatsAppAdapter.validateInbound({
      headers: { "x-hub-signature-256": sign("unit-test-app-secret", rawBody) },
      rawBody,
    });

    expect(result.kind).toBe("rejected");
  });
});

describe("MetaCloudWhatsAppAdapter capabilities/identity (§19.1)", () => {
  it("registers under the 'whatsapp_cloud' type, distinct from WhatsAppWebAdapter's 'whatsapp'", async () => {
    const { metaCloudWhatsAppAdapter } = await import("@/lib/channels/meta-whatsapp-adapter");
    expect(metaCloudWhatsAppAdapter.type).toBe("whatsapp_cloud");
  });
});
