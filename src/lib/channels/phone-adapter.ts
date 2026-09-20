import crypto from "crypto";
import {
  findConnectionByPhoneNumber,
  resolveChannelCredential,
  buildChannelCredentialContext,
  type ResolvedConnection,
} from "@/lib/identity/channel-credential-auth";
import { TwilioCredentialSchema } from "@/lib/secrets";
import type { z } from "zod";
import { validateTwilioSignature } from "./twilio-verify";
import { buildMessageReceivedEvent } from "@/lib/events/types";
import { registerInboundEvent } from "@/lib/events/inbound-receipt";
import { resolveOrCreateConversation } from "@/lib/conversations/inbound";
import { generateTwiMLGather, generateTwiMLSay } from "./phone";
import type { ChannelAdapter, ChannelStatus, NormalizedInboundRequest, OutboundContent, SendResult, ValidateInboundResult } from "./types";
import { registerChannelAdapter } from "./registry";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { TenantContext } from "@/lib/tenancy/context";
import { logger } from "@/lib/observability/logger";

type TwilioCredential = z.infer<typeof TwilioCredentialSchema>;

interface ResolvedPhoneRequest {
  resolved: ResolvedConnection;
  credential: TwilioCredential;
  ctx: TenantContext;
}

/**
 * Shared verify+resolve step for every phone webhook leg (incoming call,
 * gather-turn, status callback) — all three carry Twilio's standard
 * `To`/signature parameters, so all three resolve the same way (§14.3).
 */
async function resolvePhoneRequest(
  params: Record<string, string>,
  signature: string,
  url: string
): Promise<{ ok: true; result: ResolvedPhoneRequest } | { ok: false; reason: "unresolved" | "unconfigured" | "invalid_signature" }> {
  const to = params.To || "";
  if (!to) return { ok: false, reason: "unresolved" };

  const resolved = await findConnectionByPhoneNumber("phone", to);
  if (!resolved) return { ok: false, reason: "unresolved" };

  const credential = await resolveChannelCredential(resolved.connectionId, TwilioCredentialSchema);
  if (!credential || credential.type !== "phone") return { ok: false, reason: "unconfigured" };

  if (!validateTwilioSignature(credential.authToken, signature, url, params)) {
    return { ok: false, reason: "invalid_signature" };
  }

  const ctx = await buildChannelCredentialContext(resolved);
  return { ok: true, result: { resolved, credential, ctx } };
}

/**
 * PLAN.md §19.2/§46.5 — wraps `phone.ts`'s TwiML/Twilio-voice logic behind
 * the `ChannelAdapter` contract. `validateInbound` covers only the
 * gather-turn leg (the one point in a call's lifecycle where a customer
 * message actually exists) — the call-start and call-end legs are pure
 * call-lifecycle bookkeeping with no AI turn, handled by the standalone
 * functions below instead of forcing them through a `message.received`
 * shape they don't have. Dedup key: Twilio's `CallSid` combined with a hash
 * of the turn's `SpeechResult` (§17.4's documented fallback-heuristic
 * allowance — Twilio issues no separate id per gather-turn, only per call).
 *
 * Corrected after the Phase 5 acceptance audit: this phase's first pass
 * had `/gather` call `processInboundMessage` synchronously, reasoning
 * (wrongly) that a live call has no way to receive an asynchronous reply.
 * It does: Twilio's Calls resource supports pushing new TwiML into a
 * live, in-progress call via `update({ twiml })` (verified against
 * Twilio's own "Modify Calls In Progress" docs), which is exactly the
 * provider-supported continuation mechanism §17.6's fast-ack rule assumes
 * exists for every real channel. `/gather` now ACKs immediately with hold
 * TwiML (`generateTwiMLHold`, `channels/phone.ts`) and enqueues like every
 * other channel; `sendMessage` below is what pushes the AI's answer into
 * the still-live call once the job completes, via that same Calls API.
 * What genuinely doesn't change: Twilio's `<Gather>` action webhook is
 * synchronous by protocol (it blocks the call on the TwiML it gets back,
 * with a hard ~15s timeout before retry/fallback, per Twilio's own docs)
 * — the fix is that the *content* of that immediate response no longer
 * has to contain the AI's answer, only something that keeps the call
 * meaningfully open.
 */
export class PhoneAdapter implements ChannelAdapter<NormalizedInboundRequest> {
  readonly type = "phone";
  readonly capabilities = {
    supportsMedia: false,
    supportsTemplates: false,
    supportsTypingIndicator: false,
    supportsDeliveryReceipts: false,
    supportsMultipleConnections: true,
  };

  async validateInbound(request: NormalizedInboundRequest): Promise<ValidateInboundResult> {
    const params = request.formParams ?? {};
    const signature = request.headers["x-twilio-signature"] || "";
    const resolution = await resolvePhoneRequest(params, signature, request.url);

    if (!resolution.ok) {
      return { kind: "rejected", reason: resolution.reason };
    }

    const speechResult = (params.SpeechResult || "").trim();
    const callSid = params.CallSid || "";
    if (!speechResult || !callSid) {
      return { kind: "rejected", reason: "No speech result" };
    }

    const { ctx, resolved } = resolution.result;
    const turnDigest = crypto.createHash("sha256").update(speechResult).digest("hex").slice(0, 16);
    const externalEventId = `${callSid}:${turnDigest}`;
    const conversationId = request.routeParams.conversationId || undefined;

    const event = buildMessageReceivedEvent({
      businessId: ctx.businessId,
      channel: "phone",
      connectionId: resolved.connectionId,
      externalId: externalEventId,
      conversationId,
      payload: { text: speechResult, customerName: "Phone Caller", customerContact: params.From || "" },
      // `sendMessage()` needs both: `callSid` to know which live call to
      // push the answer into, `conversationId` to build the next turn's
      // Gather callback URL (mirroring what handleIncomingCall put there).
      metadata: { callSid, conversationId },
    });

    const registration = await registerInboundEvent(ctx, {
      source: "phone",
      externalEventId,
      eventType: event.type,
      correlationId: event.correlationId,
      event,
    });

    if (registration.isDuplicate) return { kind: "duplicate" };

    return { kind: "new", ctx, connectionId: resolved.connectionId, event, receiptId: registration.receiptId };
  }

  /**
   * Pushes the AI's answer into the still-live call via Twilio's Calls
   * resource `update({ twiml })` (verified against Twilio's own "Modify
   * Calls In Progress" docs) — this is what actually delivers the reply
   * once the async job (enqueued by `/gather`) completes; the webhook's
   * own immediate response was only ever the hold TwiML.
   */
  async sendMessage(ctx: TenantContext, connectionId: string, to: string, content: OutboundContent): Promise<SendResult> {
    const callSid = content.metadata?.callSid as string | undefined;
    if (!callSid) {
      return { success: false, error: "No callSid in metadata — cannot update a live call without knowing which one" };
    }

    const credential = await resolveChannelCredential(connectionId, TwilioCredentialSchema);
    if (!credential) return { success: false, error: "Connection has no valid Twilio credential" };

    const conversationId = content.metadata?.conversationId as string | undefined;
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "";
    const nextGatherUrl = `${baseUrl}/api/channels/phone/gather${conversationId ? `?conversationId=${conversationId}` : ""}`;
    const twiml = generateTwiMLSay(content.text, nextGatherUrl);

    try {
      const { default: twilio } = await import("twilio");
      const client = twilio(credential.accountSid, credential.authToken);
      await client.calls(callSid).update({ twiml });
      return { success: true };
    } catch (error) {
      // The caller may have already hung up (call no longer in-progress) —
      // Twilio's update then fails; log and drop rather than throw, same
      // as every other adapter's best-effort outbound delivery.
      logger.error("[PhoneAdapter] Failed to push AI response into live call:", error);
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  async getStatus(ctx: TenantContext, connectionId: string): Promise<ChannelStatus> {
    return getPhoneStatus(ctx, connectionId);
  }
}

/** PLAN.md §2.5/§46.5 — the fix: reflects the resolved connection's actual state instead of a hardcoded `false`. */
export async function getPhoneStatus(ctx: TenantContext, connectionId: string): Promise<ChannelStatus> {
  const db = getScopedPrisma(ctx);
  const connection = await db.channelConnection.findUnique({ where: { id: connectionId } });
  if (!connection?.isActive || !connection.credentialRef) {
    return { connected: false, detail: "Not configured" };
  }
  const credential = await resolveChannelCredential(connectionId, TwilioCredentialSchema);
  if (!credential) return { connected: false, detail: "Invalid or unreadable credential" };
  return { connected: true };
}

export const phoneAdapter = new PhoneAdapter();
registerChannelAdapter("phone", phoneAdapter);

// ==================== Call-lifecycle legs (no AI turn, no dedup-and-enqueue) ====================

export type PhoneWebhookResult =
  | { kind: "twiml"; twiml: string }
  | { kind: "rejected"; status: number };

const UNCONFIGURED_TWIML = generateTwiMLSayApology("Sorry, the phone system is not properly configured. Please try again later.");

function generateTwiMLSayApology(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">${message}</Say></Response>`;
}

export async function handleIncomingCall(request: NormalizedInboundRequest): Promise<PhoneWebhookResult> {
  const params = request.formParams ?? {};
  const signature = request.headers["x-twilio-signature"] || "";
  const resolution = await resolvePhoneRequest(params, signature, request.url);

  if (!resolution.ok) {
    if (resolution.reason === "invalid_signature") return { kind: "rejected", status: 403 };
    return { kind: "twiml", twiml: UNCONFIGURED_TWIML };
  }

  const { ctx, credential } = resolution.result;
  const from = params.From || "";
  const callSid = params.CallSid || "";
  const db = getScopedPrisma(ctx);

  try {
    await db.callLog.create({
      data: { businessId: ctx.businessId, callSid, from, to: credential.phoneNumber, status: "in-progress" },
    });
  } catch (error) {
    // §17.4-style redelivery protection: CallLog.callSid is @unique — a
    // retried "incoming call" webhook for the same call must not fail
    // loudly or create a second conversation, it should simply be
    // acknowledged with the same greeting again.
    logger.info("[PhoneAdapter] Duplicate incoming-call webhook (CallSid already logged)", { callSid, error });
  }

  // §46.5 acceptance-audit correction: reuses the exact same
  // resolve-customer/find-or-create-conversation logic processInboundMessage
  // itself uses (conversations/inbound.ts), rather than a second, hand-rolled
  // copy of it — this leg genuinely can't go through processInboundMessage
  // wholesale (there's no customer message yet, only a static greeting), but
  // there's no reason its conversation-resolution step should duplicate
  // logic that already exists.
  const conversation = await resolveOrCreateConversation(
    ctx,
    buildMessageReceivedEvent({
      businessId: ctx.businessId,
      channel: "phone",
      connectionId: resolution.result.resolved.connectionId,
      payload: { text: "", customerName: "Phone Caller", customerContact: from },
    })
  );

  const businessConfig = await db.businessConfig.findUnique({ where: { businessId: ctx.businessId } });
  const welcomeMessage = businessConfig?.welcomeMessage || "Hello! How can I help you today?";
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "";
  const callbackUrl = `${baseUrl}/api/channels/phone/gather?conversationId=${conversation.id}`;

  return { kind: "twiml", twiml: generateTwiMLGather(welcomeMessage, callbackUrl) };
}

export async function handleCallEnd(request: NormalizedInboundRequest): Promise<PhoneWebhookResult> {
  const params = request.formParams ?? {};
  const signature = request.headers["x-twilio-signature"] || "";
  const resolution = await resolvePhoneRequest(params, signature, request.url);

  if (!resolution.ok) {
    if (resolution.reason === "invalid_signature") return { kind: "rejected", status: 403 };
    return { kind: "twiml", twiml: "" };
  }

  const { ctx } = resolution.result;
  const db = getScopedPrisma(ctx);
  const callSid = params.CallSid || "";
  const callStatus = params.CallStatus || "";
  const callDuration = parseInt(params.CallDuration || "0", 10) || 0;

  if (callStatus === "completed" || callStatus === "failed" || callStatus === "no-answer") {
    await db.callLog.updateMany({ where: { callSid }, data: { status: "completed", duration: callDuration } });
  }

  return { kind: "twiml", twiml: "" };
}
