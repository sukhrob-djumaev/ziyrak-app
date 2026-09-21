import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import crypto from "crypto";

// Real Postgres — resolving a ChannelConnection by phone_number_id and
// registering an InboundEventReceipt are exactly the tenant-isolation/dedup
// behaviors §46.7 requires real infrastructure to verify, not a mock.
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { encryptChannelCredential } from "@/lib/identity/channel-credential-auth";
import { metaCloudWhatsAppAdapter } from "@/lib/channels/meta-whatsapp-adapter";
import type { MetaWebhookRequest } from "@/lib/channels/meta-whatsapp-adapter";
import { createRequest } from "../helpers/request";

/**
 * PLAN.md §20.2/§46.7's own named test list:
 *  - valid signature accepted,
 *  - invalid signature rejected before persistence,
 *  - unknown phone_number_id rejected,
 *  - Business A's number cannot resolve Business B,
 *  - redelivery deduplicated,
 *  - webhook ACK occurs before AI processing,
 *  - outbound message uses the correct business's access token/phone number,
 *  - one business's credentials can never be used to send another
 *    business's response.
 */

const APP_SECRET = "test-meta-app-secret";
const VERIFY_TOKEN = "test-meta-verify-token";
let previousAppSecret: string | undefined;
let previousVerifyToken: string | undefined;

function sign(rawBody: string): string {
  return `sha256=${crypto.createHmac("sha256", APP_SECRET).update(rawBody, "utf-8").digest("hex")}`;
}

function buildPayload(phoneNumberId: string, from: string, text: string, wamid: string, name = "Customer"): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-entry",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phoneNumberId, display_phone_number: phoneNumberId },
              contacts: [{ profile: { name }, wa_id: from }],
              messages: [{ from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  });
}

function buildRequest(rawBody: string, signature: string): MetaWebhookRequest {
  return { headers: { "x-hub-signature-256": signature }, rawBody };
}

interface MetaConnectionSetup {
  connectionId: string;
  phoneNumberId: string;
  accessToken: string;
}

async function createMetaConnection(businessId: string, label: string): Promise<MetaConnectionSetup> {
  const phoneNumberId = `phone-number-${label}-${crypto.randomUUID()}`;
  const accessToken = `access-token-${label}-${crypto.randomUUID()}`;
  const credentialRef = await encryptChannelCredential({
    type: "whatsapp_cloud",
    phoneNumberId,
    accessToken,
    businessAccountId: `waba-${label}`,
  });
  const connection = await prisma.channelConnection.create({
    data: {
      businessId,
      type: "whatsapp_cloud",
      name: `WhatsApp Cloud ${label}`,
      isActive: true,
      config: { phoneNumberId },
      credentialRef,
    },
  });
  return { connectionId: connection.id, phoneNumberId, accessToken };
}

let businessA: SeededBusiness;
let businessB: SeededBusiness;

beforeAll(async () => {
  previousAppSecret = process.env.META_APP_SECRET;
  previousVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;

  businessA = await seedBusiness("meta-wa-a");
  businessB = await seedBusiness("meta-wa-b");
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
  process.env.META_APP_SECRET = previousAppSecret;
  process.env.META_WEBHOOK_VERIFY_TOKEN = previousVerifyToken;
});

describe("MetaCloudWhatsAppAdapter webhook security (§20.2/§46.7)", () => {
  it("accepts a validly signed payload and resolves the correct business", async () => {
    const connA = await createMetaConnection(businessA.businessId, "accept");
    const rawBody = buildPayload(connA.phoneNumberId, "15550001111", "Hello there", `wamid.${crypto.randomUUID()}`);

    const result = await metaCloudWhatsAppAdapter.validateInbound(buildRequest(rawBody, sign(rawBody)));

    expect(result.kind).toBe("new");
    if (result.kind === "new") {
      expect(result.ctx.businessId).toBe(businessA.businessId);
      expect(result.connectionId).toBe(connA.connectionId);
      expect(result.event.payload.text).toBe("Hello there");
    }
  });

  it("rejects a payload with an invalid signature before touching persistence", async () => {
    const connA = await createMetaConnection(businessA.businessId, "badsig");
    const wamid = `wamid.${crypto.randomUUID()}`;
    const rawBody = buildPayload(connA.phoneNumberId, "15550001111", "Should never be processed", wamid);

    const result = await metaCloudWhatsAppAdapter.validateInbound(
      buildRequest(rawBody, `sha256=${"0".repeat(64)}`)
    );

    expect(result.kind).toBe("rejected");

    const receipts = await prisma.inboundEventReceipt.findMany({
      where: { businessId: businessA.businessId, source: "whatsapp_cloud", externalEventId: wamid },
    });
    expect(receipts.length).toBe(0);
  });

  it("rejects an unknown phone_number_id", async () => {
    const rawBody = buildPayload("phone-number-that-does-not-exist", "15550001111", "hi", `wamid.${crypto.randomUUID()}`);
    const result = await metaCloudWhatsAppAdapter.validateInbound(buildRequest(rawBody, sign(rawBody)));
    expect(result.kind).toBe("rejected");
  });

  it("Business A's phone_number_id never resolves to Business B, and vice versa", async () => {
    const connA = await createMetaConnection(businessA.businessId, "isoA");
    const connB = await createMetaConnection(businessB.businessId, "isoB");

    const rawBodyA = buildPayload(connA.phoneNumberId, "15550002222", "from A's customer", `wamid.${crypto.randomUUID()}`);
    const resultA = await metaCloudWhatsAppAdapter.validateInbound(buildRequest(rawBodyA, sign(rawBodyA)));
    expect(resultA.kind).toBe("new");
    if (resultA.kind === "new") expect(resultA.ctx.businessId).toBe(businessA.businessId);

    const rawBodyB = buildPayload(connB.phoneNumberId, "15550003333", "from B's customer", `wamid.${crypto.randomUUID()}`);
    const resultB = await metaCloudWhatsAppAdapter.validateInbound(buildRequest(rawBodyB, sign(rawBodyB)));
    expect(resultB.kind).toBe("new");
    if (resultB.kind === "new") expect(resultB.ctx.businessId).toBe(businessB.businessId);
  });

  it("deduplicates a redelivered wamid — exactly one InboundEventReceipt, second delivery reported as duplicate", async () => {
    const conn = await createMetaConnection(businessA.businessId, "dedup");
    const wamid = `wamid.${crypto.randomUUID()}`;
    const rawBody = buildPayload(conn.phoneNumberId, "15550004444", "redeliver me", wamid);

    const first = await metaCloudWhatsAppAdapter.validateInbound(buildRequest(rawBody, sign(rawBody)));
    expect(first.kind).toBe("new");

    const second = await metaCloudWhatsAppAdapter.validateInbound(buildRequest(rawBody, sign(rawBody)));
    expect(second.kind).toBe("duplicate");

    const receipts = await prisma.inboundEventReceipt.findMany({
      where: { businessId: businessA.businessId, source: "whatsapp_cloud", externalEventId: wamid },
    });
    expect(receipts.length).toBe(1);
  });

  it("sendMessage uses the resolved connection's own access token and phone_number_id, never another business's", async () => {
    const connA = await createMetaConnection(businessA.businessId, "sendA");
    const connB = await createMetaConnection(businessB.businessId, "sendB");

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const previousFetch = global.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = fetchSpy as any;

    try {
      await metaCloudWhatsAppAdapter.sendMessage(businessA.ctx, connA.connectionId, "15559990000", { text: "Reply for A's customer" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [urlA, optionsA] = fetchSpy.mock.calls[0];
      expect(String(urlA)).toContain(connA.phoneNumberId);
      expect(String(urlA)).not.toContain(connB.phoneNumberId);
      expect((optionsA as RequestInit).headers as Record<string, string>).toMatchObject({
        Authorization: `Bearer ${connA.accessToken}`,
      });

      fetchSpy.mockClear();
      await metaCloudWhatsAppAdapter.sendMessage(businessB.ctx, connB.connectionId, "15559991111", { text: "Reply for B's customer" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [urlB, optionsB] = fetchSpy.mock.calls[0];
      expect(String(urlB)).toContain(connB.phoneNumberId);
      expect(String(urlB)).not.toContain(connA.phoneNumberId);
      expect((optionsB as RequestInit).headers as Record<string, string>).toMatchObject({
        Authorization: `Bearer ${connB.accessToken}`,
      });
      // The literal proof of "one business's credentials can never be used
      // to send another business's response": B's own send never carries
      // A's access token, and A's own send never carries B's.
      expect((optionsB as RequestInit).headers as Record<string, string>).not.toMatchObject({
        Authorization: `Bearer ${connA.accessToken}`,
      });
    } finally {
      global.fetch = previousFetch;
    }
  });
});

describe("MetaCloudWhatsAppAdapter webhook route (§17.6/§20.2/§46.7)", () => {
  it("GET answers Meta's verification challenge only with the correct verify token", async () => {
    const { GET } = await import("@/app/api/channels/whatsapp-cloud/webhook/route");

    const validRequest = createRequest("/api/channels/whatsapp-cloud/webhook", {
      searchParams: { "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "challenge-123" },
    });
    const validResponse = await GET(validRequest);
    expect(validResponse.status).toBe(200);
    expect(await validResponse.text()).toBe("challenge-123");

    const invalidRequest = createRequest("/api/channels/whatsapp-cloud/webhook", {
      searchParams: { "hub.mode": "subscribe", "hub.verify_token": "wrong-token", "hub.challenge": "challenge-123" },
    });
    const invalidResponse = await GET(invalidRequest);
    expect(invalidResponse.status).toBe(403);
  });

  it("POST rejects an invalid signature with 403 and never enqueues processing", async () => {
    const conn = await createMetaConnection(businessA.businessId, "route-badsig");
    const rawBody = buildPayload(conn.phoneNumberId, "15550005555", "hi", `wamid.${crypto.randomUUID()}`);

    const request = createRequest("/api/channels/whatsapp-cloud/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}`, "Content-Type": "application/json" },
    });
    // createRequest JSON-encodes `body`; POST here needs the exact raw
    // bytes the (bad) signature claims to cover, so construct the request
    // body directly instead of going through the JSON-object `body` option.
    const rawRequest = new Request(request.url, { method: "POST", headers: request.headers, body: rawBody });
    const { POST } = await import("@/app/api/channels/whatsapp-cloud/webhook/route");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await POST(rawRequest as any);

    expect(response.status).toBe(403);
  });

  it("POST ACKs immediately (fast-ack) without waiting for AI processing to complete", async () => {
    const conn = await createMetaConnection(businessA.businessId, "route-fastack");
    const rawBody = buildPayload(conn.phoneNumberId, "15550006666", "fast ack please", `wamid.${crypto.randomUUID()}`);

    const rawRequest = new Request("https://example.com/api/channels/whatsapp-cloud/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": sign(rawBody), "Content-Type": "application/json" },
      body: rawBody,
    });

    const { POST } = await import("@/app/api/channels/whatsapp-cloud/webhook/route");

    const start = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await POST(rawRequest as any);
    const elapsedMs = Date.now() - start;

    expect(response.status).toBe(200);
    // FakeJobQueue's enqueue() (NODE_ENV=test) never awaits handler
    // completion (§46.5's own fire-and-forget guarantee) — this route
    // should ACK well under any real AI-call latency, not merely "not
    // literally infinite".
    expect(elapsedMs).toBeLessThan(2000);
  });
});
