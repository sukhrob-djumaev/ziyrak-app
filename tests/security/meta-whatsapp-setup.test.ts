import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import crypto from "crypto";

// Real Postgres: the properties under test (cross-business claim rejection,
// ambiguity fail-closed routing) are exactly cross-tenant query behavior.
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import * as connectionsService from "@/lib/channels/connections-service";
import { findConnectionByConfigField, encryptChannelCredential } from "@/lib/identity/channel-credential-auth";
import { metaCloudWhatsAppAdapter } from "@/lib/channels/meta-whatsapp-adapter";

/**
 * PLAN.md §7.7/§20.2/§46.7 — a Meta `phone_number_id` is what routes inbound
 * WhatsApp traffic to a business, and it is not a secret. These tests prove
 * one business cannot start receiving another's customers by typing that id
 * into its own connection: saving requires an access token that can actually
 * read the number, ids are exclusive across businesses, and the routing key
 * can never be set through a plain `config` write.
 */

let businessA: SeededBusiness;
let businessB: SeededBusiness;
const realFetch = global.fetch;
let graphResponses: Map<string, boolean>;

function credential(phoneNumberId: string, accessToken = "token") {
  return { type: "whatsapp_cloud" as const, phoneNumberId, accessToken, businessAccountId: "waba-1" };
}

beforeAll(async () => {
  businessA = await seedBusiness("meta-setup-a");
  businessB = await seedBusiness("meta-setup-b");
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

beforeEach(() => {
  graphResponses = new Map();
  // Fake Graph API: `<phoneNumberId>|<token>` pairs registered as valid.
  global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const id = decodeURIComponent(String(url).split("/").pop()!.split("?")[0]);
    const token = String((init?.headers as Record<string, string>)?.Authorization ?? "").replace("Bearer ", "");
    const ok = graphResponses.get(`${id}|${token}`) === true;
    return { ok, status: ok ? 200 : 400, json: async () => (ok ? { id } : { error: "invalid" }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
});

afterEach(() => {
  global.fetch = realFetch;
});

describe("Meta Cloud connection setup (§46.7)", () => {
  it("saves a connection when the access token can read the phone number, deriving the routing key from the verified credential", async () => {
    const phoneNumberId = `pn-${crypto.randomUUID()}`;
    graphResponses.set(`${phoneNumberId}|good-token`, true);

    const saved = await connectionsService.upsertByType(businessA.ctx, "whatsapp_cloud", {
      isActive: true,
      config: { phoneNumberId: "client-supplied-and-ignored" },
      credential: credential(phoneNumberId, "good-token"),
    });

    expect((saved.config as { phoneNumberId: string }).phoneNumberId).toBe(phoneNumberId);
    const resolved = await findConnectionByConfigField("whatsapp_cloud", "phoneNumberId", phoneNumberId);
    expect(resolved?.businessId).toBe(businessA.businessId);
  });

  it("rejects a credential whose token cannot read that phone number (no proof of ownership), storing nothing for the caller", async () => {
    const victimNumber = `pn-${crypto.randomUUID()}`;
    graphResponses.set(`${victimNumber}|victim-token`, true);

    await expect(
      connectionsService.upsertByType(businessB.ctx, "whatsapp_cloud", { isActive: true, credential: credential(victimNumber, "attacker-token") })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(await findConnectionByConfigField("whatsapp_cloud", "phoneNumberId", victimNumber)).toBeNull();
  });

  it("refuses to let Business B claim a phone number Business A already connected, even with a valid token", async () => {
    const phoneNumberId = `pn-${crypto.randomUUID()}`;
    graphResponses.set(`${phoneNumberId}|token-a`, true);
    graphResponses.set(`${phoneNumberId}|token-b`, true);

    await connectionsService.upsertByType(businessA.ctx, "whatsapp_cloud", { isActive: true, credential: credential(phoneNumberId, "token-a") });

    // Business B's connection row may already exist from a previous test; the
    // claim must be refused regardless.
    await expect(
      connectionsService.upsertByType(businessB.ctx, "whatsapp_cloud", { isActive: true, credential: credential(phoneNumberId, "token-b") })
    ).rejects.toMatchObject({ statusCode: 409 });

    const resolved = await findConnectionByConfigField("whatsapp_cloud", "phoneNumberId", phoneNumberId);
    expect(resolved?.businessId).toBe(businessA.businessId);
  });

  it("cannot point a connection at another business's number through a credential-less config write", async () => {
    const victimNumber = `pn-${crypto.randomUUID()}`;
    graphResponses.set(`${victimNumber}|victim-token`, true);
    await connectionsService.upsertByType(businessA.ctx, "whatsapp_cloud", { isActive: true, credential: credential(victimNumber, "victim-token") });

    await connectionsService.upsertByType(businessB.ctx, "whatsapp_cloud", { isActive: true, config: { phoneNumberId: victimNumber } });

    const resolved = await findConnectionByConfigField("whatsapp_cloud", "phoneNumberId", victimNumber);
    expect(resolved?.businessId).toBe(businessA.businessId);
    const rowB = await prisma.channelConnection.findFirst({ where: { businessId: businessB.businessId, type: "whatsapp_cloud" } });
    expect((rowB!.config as Record<string, unknown>).phoneNumberId).not.toBe(victimNumber);
  });

  it("a config-only update keeps the already-verified routing key instead of dropping it", async () => {
    const phoneNumberId = `pn-${crypto.randomUUID()}`;
    graphResponses.set(`${phoneNumberId}|tok`, true);
    await connectionsService.upsertByType(businessA.ctx, "whatsapp_cloud", { isActive: true, credential: credential(phoneNumberId, "tok") });

    await connectionsService.upsertByType(businessA.ctx, "whatsapp_cloud", { config: { displayName: "Support" } });

    const row = await prisma.channelConnection.findFirst({ where: { businessId: businessA.businessId, type: "whatsapp_cloud" } });
    expect(row!.config).toMatchObject({ phoneNumberId, displayName: "Support" });
  });

  it("rejects a credential with the wrong type instead of storing it", async () => {
    await expect(
      connectionsService.upsertByType(businessA.ctx, "whatsapp_cloud", {
        isActive: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        credential: { type: "telegram", botToken: "x" } as any,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("ambiguous routing fails closed (§7.7/§46.7)", () => {
  it("if two active connections ever share a phone_number_id, inbound resolves to neither business", async () => {
    const phoneNumberId = `pn-dup-${crypto.randomUUID()}`;
    const credentialRef = await encryptChannelCredential({ type: "whatsapp_cloud", phoneNumberId, accessToken: "t", businessAccountId: "w" });
    for (const b of [businessA, businessB]) {
      await prisma.channelConnection.create({
        data: { businessId: b.businessId, type: "whatsapp_cloud", name: "dup", isActive: true, config: { phoneNumberId }, credentialRef },
      });
    }

    expect(await findConnectionByConfigField("whatsapp_cloud", "phoneNumberId", phoneNumberId)).toBeNull();

    const previous = process.env.META_APP_SECRET;
    process.env.META_APP_SECRET = "ambiguity-secret";
    try {
      const rawBody = JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ id: "w", changes: [{ field: "messages", value: {
          metadata: { phone_number_id: phoneNumberId },
          messages: [{ from: "15550009999", id: `wamid.${crypto.randomUUID()}`, timestamp: "1700000000", type: "text", text: { body: "hi" } }],
        } }] }],
      });
      const signature = `sha256=${crypto.createHmac("sha256", "ambiguity-secret").update(rawBody).digest("hex")}`;
      const result = await metaCloudWhatsAppAdapter.validateInbound({ headers: { "x-hub-signature-256": signature }, rawBody });
      expect(result.kind).toBe("rejected");
    } finally {
      process.env.META_APP_SECRET = previous;
    }
  });
});
