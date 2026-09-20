import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import crypto from "crypto";

// Real Postgres — resolving a ChannelConnection by provider identifier and
// registering an InboundEventReceipt are exactly the tenant-isolation/dedup
// behaviors §46.5 requires real infrastructure to verify, not a mock.
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
import { prisma } from "@/lib/prisma/raw-client";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { encryptChannelCredential } from "@/lib/identity/channel-credential-auth";
import { smsAdapter } from "@/lib/channels/sms-adapter";
import { telegramAdapter } from "@/lib/channels/telegram-adapter";
import { phoneAdapter, getPhoneStatus } from "@/lib/channels/phone-adapter";
import type { NormalizedInboundRequest } from "@/lib/channels/types";

/**
 * PLAN.md §14.3/§17.4/§33.4 item 1/§46.5 — real-Postgres tenant-resolution
 * and dedup tests for the three HTTP-webhook channels resolved by a
 * provider-supplied identifier (SMS/Phone by `To` number, Telegram by
 * `connectionId` in the path). Two ordinary businesses, each with its own
 * `ChannelConnection` + encrypted credential — exactly the shape §46.5
 * requires ("no inbound channel is allowed to silently use the Default
 * Business", "add explicit multi-business tests").
 */

function signTwilio(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], "");
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

let businessA: SeededBusiness;
let businessB: SeededBusiness;

beforeAll(async () => {
  businessA = await seedBusiness("chan-res-a");
  businessB = await seedBusiness("chan-res-b");
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

describe("SMS/Phone tenant resolution by Twilio number (§14.3/§46.5)", () => {
  it("resolves the correct business by the Twilio 'To' number and rejects an unrecognized one", async () => {
    const numberA = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
    const numberB = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
    const authTokenA = "auth-token-a";
    const authTokenB = "auth-token-b";

    const credentialRefA = await encryptChannelCredential({
      type: "sms",
      accountSid: "ACa",
      authToken: authTokenA,
      phoneNumber: numberA,
    });
    const credentialRefB = await encryptChannelCredential({
      type: "sms",
      accountSid: "ACb",
      authToken: authTokenB,
      phoneNumber: numberB,
    });

    await prisma.channelConnection.create({
      data: {
        businessId: businessA.businessId,
        type: "sms",
        name: "SMS A",
        isActive: true,
        config: { phoneNumber: numberA },
        credentialRef: credentialRefA,
      },
    });
    await prisma.channelConnection.create({
      data: {
        businessId: businessB.businessId,
        type: "sms",
        name: "SMS B",
        isActive: true,
        config: { phoneNumber: numberB },
        credentialRef: credentialRefB,
      },
    });

    const url = "https://example.com/api/channels/sms";
    const paramsA = { To: numberA, From: "+15559998888", Body: "Hi from customer A", MessageSid: `SM-${crypto.randomUUID()}` };
    const requestA: NormalizedInboundRequest = {
      headers: { "x-twilio-signature": signTwilio(authTokenA, url, paramsA) },
      routeParams: {},
      formParams: paramsA,
      url,
    };

    const resultA = await smsAdapter.validateInbound(requestA);
    expect(resultA.kind).toBe("new");
    if (resultA.kind === "new") {
      expect(resultA.ctx.businessId).toBe(businessA.businessId);
      expect(resultA.event.businessId).toBe(businessA.businessId);
    }

    // Business B's number with Business A's signature must be rejected —
    // proves the credential used for verification is the *resolved*
    // connection's own, not a shared/global one.
    const crossParams = { ...paramsA, To: numberB };
    const crossRequest: NormalizedInboundRequest = {
      headers: { "x-twilio-signature": signTwilio(authTokenA, url, crossParams) },
      routeParams: {},
      formParams: crossParams,
      url,
    };
    const crossResult = await smsAdapter.validateInbound(crossRequest);
    expect(crossResult.kind).toBe("rejected");

    // Redelivery of the exact same MessageSid is deduped, not reprocessed.
    const replay = await smsAdapter.validateInbound(requestA);
    expect(replay.kind).toBe("duplicate");

    // An unrecognized number is rejected outright.
    const unknownParams = { ...paramsA, To: "+19995550000", MessageSid: `SM-${crypto.randomUUID()}` };
    const unknownRequest: NormalizedInboundRequest = {
      headers: { "x-twilio-signature": signTwilio(authTokenA, url, unknownParams) },
      routeParams: {},
      formParams: unknownParams,
      url,
    };
    expect((await smsAdapter.validateInbound(unknownRequest)).kind).toBe("rejected");
  });

  it("Phone: dedups per gather-turn (CallSid + speech content) and rejects a bad signature", async () => {
    const number = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
    const authToken = "phone-auth-token";
    const credentialRef = await encryptChannelCredential({
      type: "phone",
      accountSid: "ACp",
      authToken,
      phoneNumber: number,
    });
    await prisma.channelConnection.create({
      data: {
        businessId: businessA.businessId,
        type: "phone",
        name: "Phone A",
        isActive: true,
        config: { phoneNumber: number },
        credentialRef,
      },
    });

    const url = "https://example.com/api/channels/phone/gather";
    const callSid = `CA-${crypto.randomUUID()}`;
    const params = { To: number, From: "+15551110000", SpeechResult: "I need help", CallSid: callSid };
    const request: NormalizedInboundRequest = {
      headers: { "x-twilio-signature": signTwilio(authToken, url, params) },
      routeParams: {},
      formParams: params,
      url,
    };

    const result = await phoneAdapter.validateInbound(request);
    expect(result.kind).toBe("new");
    if (result.kind === "new") expect(result.ctx.businessId).toBe(businessA.businessId);

    // Same call, same speech (Twilio's own webhook retry) → deduped.
    expect((await phoneAdapter.validateInbound(request)).kind).toBe("duplicate");

    // Same call, a genuinely new turn (different speech) → not a duplicate.
    const secondTurnParams = { ...params, SpeechResult: "Actually, cancel my order" };
    const secondTurnRequest: NormalizedInboundRequest = {
      headers: { "x-twilio-signature": signTwilio(authToken, url, secondTurnParams) },
      routeParams: {},
      formParams: secondTurnParams,
      url,
    };
    expect((await phoneAdapter.validateInbound(secondTurnRequest)).kind).toBe("new");

    // Wrong signature → rejected outright.
    const badRequest: NormalizedInboundRequest = {
      headers: { "x-twilio-signature": "not-a-real-signature" },
      routeParams: {},
      formParams: { ...params, SpeechResult: "third turn" },
      url,
    };
    expect((await phoneAdapter.validateInbound(badRequest)).kind).toBe("rejected");
  });

  it("getPhoneStatus() reflects real configuration state (§2.5/§46.5's fix for the hardcoded-false bug)", async () => {
    const unconfigured = await prisma.channelConnection.create({
      data: { businessId: businessB.businessId, type: "phone", name: "Phone Unconfigured", isActive: false, config: {} },
    });
    const unconfiguredStatus = await getPhoneStatus(businessB.ctx, unconfigured.id);
    expect(unconfiguredStatus.connected).toBe(false);

    const number = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
    const credentialRef = await encryptChannelCredential({ type: "phone", accountSid: "ACstatus", authToken: "status-token", phoneNumber: number });
    const configured = await prisma.channelConnection.create({
      data: { businessId: businessB.businessId, type: "phone", name: "Phone Configured", isActive: true, config: { phoneNumber: number }, credentialRef },
    });
    const configuredStatus = await getPhoneStatus(businessB.ctx, configured.id);
    expect(configuredStatus.connected).toBe(true);
  });
});

describe("Telegram tenant resolution by connectionId + secret token (§19.2/§32/§46.5)", () => {
  it("resolves the correct business and requires the matching secret token", async () => {
    const secretTokenA = "telegram-secret-a";
    const credentialRef = await encryptChannelCredential({
      type: "telegram",
      botToken: "123:bot-token-a",
      secretToken: secretTokenA,
    });
    const connection = await prisma.channelConnection.create({
      data: {
        businessId: businessA.businessId,
        type: "telegram",
        name: "Telegram A",
        isActive: true,
        config: {},
        credentialRef,
      },
    });

    const update = {
      update_id: Math.floor(Math.random() * 1_000_000),
      message: {
        message_id: 1,
        from: { id: 555, first_name: "Jane" },
        chat: { id: 555, type: "private" },
        text: "Hello there",
        date: Math.floor(Date.now() / 1000),
      },
    };

    const validRequest: NormalizedInboundRequest = {
      headers: { "x-telegram-bot-api-secret-token": secretTokenA },
      routeParams: { connectionId: connection.id },
      json: update,
      url: `https://example.com/api/channels/telegram/${connection.id}`,
    };

    const result = await telegramAdapter.validateInbound(validRequest);
    expect(result.kind).toBe("new");
    if (result.kind === "new") {
      expect(result.ctx.businessId).toBe(businessA.businessId);
      // §46.5's own fix: the contact used for delivery is the numeric chat
      // id, never `@username` (Telegram rejects `@username` as a DM target).
      expect(result.event.payload.customerContact).toBe("555");
    }

    // Redelivery of the identical update_id → deduped.
    expect((await telegramAdapter.validateInbound(validRequest)).kind).toBe("duplicate");

    // Wrong secret token → rejected, even for the right connectionId.
    const wrongSecretRequest: NormalizedInboundRequest = {
      ...validRequest,
      headers: { "x-telegram-bot-api-secret-token": "wrong-secret" },
      json: { ...update, update_id: update.update_id + 1 },
    };
    expect((await telegramAdapter.validateInbound(wrongSecretRequest)).kind).toBe("rejected");

    // Business B's widget cannot forge Business A's connectionId path —
    // an unrelated connectionId simply doesn't resolve.
    const unknownConnectionRequest: NormalizedInboundRequest = {
      headers: { "x-telegram-bot-api-secret-token": secretTokenA },
      routeParams: { connectionId: "not-a-real-connection" },
      json: { ...update, update_id: update.update_id + 2 },
      url: "https://example.com/api/channels/telegram/not-a-real-connection",
    };
    expect((await telegramAdapter.validateInbound(unknownConnectionRequest)).kind).toBe("rejected");
  });
});
