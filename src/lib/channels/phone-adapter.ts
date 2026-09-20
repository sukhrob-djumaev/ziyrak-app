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
import { resolveCustomer } from "@/lib/customers/customer-resolver";
import { createNewConversation } from "@/lib/conversations/conversation-service";
import { generateTwiMLGather } from "./phone";
import type { ChannelAdapter, ChannelStatus, NormalizedInboundRequest, SendResult, ValidateInboundResult } from "./types";
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
 * A live call's gather-turn cannot go through the fast-ack/enqueue/worker
 * pattern the way every other channel does (§17.6): the caller is on the
 * phone waiting for a synchronous TwiML response, and there is no
 * mechanism to "call back" into an active call asynchronously. Per §17.5's
 * own rule ("a direct, synchronous call when the caller needs the result
 * to proceed"), the `/gather` route calls `processInboundMessage` directly
 * after `validateInbound` returns `"new"`, instead of enqueuing — the
 * dedup/persistence guarantee is identical, only the dispatch is
 * synchronous. `sendMessage` is therefore a documented no-op: the reply is
 * already in hand as text before `processInboundMessage` returns, and is
 * delivered as TwiML in the same HTTP response, not through a second,
 * separate outbound call.
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
      metadata: { callSid },
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

  async sendMessage(): Promise<SendResult> {
    return { success: true };
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

  const customerId = await resolveCustomer(ctx, "phone", from, "Phone Caller");

  let conversation = await db.conversation.findFirst({
    where: { channel: "phone", status: { in: ["active", "escalated"] }, OR: [{ customerId }, { customerContact: from }] },
  });
  if (!conversation) {
    conversation = await createNewConversation(ctx, "phone", "Phone Caller", from, customerId);
  }

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
