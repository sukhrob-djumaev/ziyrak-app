import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import crypto from "crypto";

// Real Postgres — proving what actually gets persisted end-to-end, not
// just the HTTP response shape (§46.5's own acceptance criteria: fast-ack
// AND unified processInboundMessage integration, together).
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

let resolveAICall!: (text: string) => void;
const mockOpenAICreateFn = vi.fn().mockImplementation(
  () =>
    new Promise((resolve) => {
      resolveAICall = (text: string) =>
        resolve({ choices: [{ finish_reason: "stop", message: { content: text } }] });
    })
);
vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockOpenAICreateFn } };
  },
}));

const twilioSendSpy = vi.fn().mockResolvedValue({ sid: "SM-outbound" });
vi.mock("twilio", () => ({
  default: () => ({ messages: { create: twilioSendSpy } }),
}));

import { prisma } from "@/lib/prisma/raw-client";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { encryptChannelCredential } from "@/lib/identity/channel-credential-auth";
import { encryptAIProviderCredential } from "@/lib/ai/config";
import { jobQueue } from "@/lib/jobs/queue";
import type { FakeJobQueue } from "@/lib/jobs/fake-job-queue";

function signTwilio(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], "");
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

function buildFormRequest(url: string, params: Record<string, string>, headers: Record<string, string>): NextRequest {
  const body = new URLSearchParams(params).toString();
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
}

let business: SeededBusiness;
const phoneNumber = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
const authToken = "sms-fast-ack-token";

beforeAll(async () => {
  business = await seedBusiness("fast-ack");

  const credentialRef = await encryptChannelCredential({
    type: "sms",
    accountSid: "ACfastack",
    authToken,
    phoneNumber,
  });
  await prisma.channelConnection.create({
    data: {
      businessId: business.businessId,
      type: "sms",
      name: "SMS Fast Ack",
      isActive: true,
      config: { phoneNumber },
      credentialRef,
    },
  });

  const aiCredentialRef = await encryptAIProviderCredential("openai", "sk-test-fast-ack");
  await prisma.businessConfig.create({
    data: { businessId: business.businessId, aiProvider: "openai", aiCredentialRef },
  });
});

afterAll(async () => {
  await cleanupBusiness(business.businessId);
});

describe("Fast-ack + unified processInboundMessage pipeline (§17.6/§18.2/§46.5)", () => {
  it("the SMS webhook ACKs before the (artificially delayed) AI call resolves, and the full pipeline completes once it does", async () => {
    const { POST } = await import("@/app/api/channels/sms/route");

    const url = "https://example.com/api/channels/sms";
    const params = {
      To: phoneNumber,
      From: "+15557778888",
      Body: "Do you have same-day shipping?",
      MessageSid: `SM-${crypto.randomUUID()}`,
    };
    const request = buildFormRequest(url, params, { "x-twilio-signature": signTwilio(authToken, url, params) });

    // The AI call's promise is deliberately never resolved until after we
    // observe the webhook's own response — if the implementation ever
    // regressed to awaiting AI completion inline (§17.6), this `await`
    // would hang until the test's timeout, not merely respond slowly.
    const response = await POST(request);
    expect(response.status).toBe(200);
    const twiml = await response.text();
    expect(twiml).toContain("<Response");

    // Nothing has been delivered back to the customer yet — the AI call is
    // still pending, deliberately held open by this test.
    expect(twilioSendSpy).not.toHaveBeenCalled();

    // The enqueued job runs on its own microtask schedule (§46.5's
    // FakeJobQueue is fire-and-forget) — wait for it to actually reach the
    // AI call before resolving it.
    await vi.waitFor(() => expect(mockOpenAICreateFn).toHaveBeenCalled());

    // Now let the (fake) worker's AI call complete and drain the queue.
    resolveAICall("Yes! Orders placed before 2pm ship same day.");
    await (jobQueue as unknown as FakeJobQueue).__drainForTests();

    // processInboundMessage's full, real (Postgres-backed) effect: a
    // Conversation was created, both messages persisted, and the reply was
    // sent back out through SmsAdapter.sendMessage → Twilio's real outbound
    // API shape (not the webhook's own TwiML body, §17.6's own reasoning
    // for SMS specifically).
    const conversation = await prisma.conversation.findFirst({
      where: { businessId: business.businessId, channel: "sms", customerContact: params.From },
    });
    expect(conversation).not.toBeNull();

    const messages = await prisma.message.findMany({ where: { conversationId: conversation!.id }, orderBy: { createdAt: "asc" } });
    expect(messages.some((m) => m.role === "customer" && m.content === params.Body)).toBe(true);
    expect(messages.some((m) => m.role === "assistant" && m.content === "Yes! Orders placed before 2pm ship same day.")).toBe(true);

    expect(twilioSendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        to: params.From,
        from: phoneNumber,
        body: "Yes! Orders placed before 2pm ship same day.",
      })
    );

    // §17.4/§33.4 item 1 — redelivery of the identical MessageSid must not
    // create a second conversation chain or a second AI/outbound call.
    twilioSendSpy.mockClear();
    mockOpenAICreateFn.mockClear();
    const replay = buildFormRequest(url, params, { "x-twilio-signature": signTwilio(authToken, url, params) });
    const replayResponse = await POST(replay);
    expect(replayResponse.status).toBe(200);
    await (jobQueue as unknown as FakeJobQueue).__drainForTests();
    expect(mockOpenAICreateFn).not.toHaveBeenCalled();
    expect(twilioSendSpy).not.toHaveBeenCalled();

    const messagesAfterReplay = await prisma.message.findMany({ where: { conversationId: conversation!.id } });
    expect(messagesAfterReplay.length).toBe(messages.length);
  });
});
