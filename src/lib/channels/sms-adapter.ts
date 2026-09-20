import { validateTwilioSignature } from "./twilio-verify";
import { findConnectionByPhoneNumber, resolveChannelCredential, buildChannelCredentialContext } from "@/lib/identity/channel-credential-auth";
import { TwilioCredentialSchema } from "@/lib/secrets";
import { buildMessageReceivedEvent } from "@/lib/events/types";
import { registerInboundEvent } from "@/lib/events/inbound-receipt";
import type { ChannelAdapter, ChannelStatus, NormalizedInboundRequest, OutboundContent, SendResult, ValidateInboundResult } from "./types";
import { registerChannelAdapter } from "./registry";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { TenantContext } from "@/lib/tenancy/context";
import { logger } from "@/lib/observability/logger";

/**
 * PLAN.md §19.2/§46.5 — wraps `sms.ts`'s Twilio SMS logic behind the
 * `ChannelAdapter` contract. Twilio signature verification now uses the
 * *resolved connection's own* decrypted `authToken` (§14.3) rather than the
 * legacy global `Settings.twilioToken` every business used to share.
 * Dedup key: Twilio's `MessageSid` (§17.4/§19.2 — a stable, provider-issued
 * id, no fallback heuristic needed).
 */
export class SmsAdapter implements ChannelAdapter<NormalizedInboundRequest> {
  readonly type = "sms";
  readonly capabilities = {
    supportsMedia: false,
    supportsTemplates: false,
    supportsTypingIndicator: false,
    supportsDeliveryReceipts: true,
    supportsMultipleConnections: true,
  };

  async validateInbound(request: NormalizedInboundRequest): Promise<ValidateInboundResult> {
    const params = request.formParams ?? {};
    const to = params.To || "";
    const from = params.From || "";
    const body = params.Body || "";
    const messageSid = params.MessageSid || "";

    if (!to || !messageSid) {
      return { kind: "rejected", reason: "Missing To/MessageSid" };
    }

    const resolved = await findConnectionByPhoneNumber("sms", to);
    if (!resolved) {
      return { kind: "rejected", reason: "No active ChannelConnection matches this Twilio number" };
    }

    const credential = await resolveChannelCredential(resolved.connectionId, TwilioCredentialSchema);
    if (!credential) {
      return { kind: "rejected", reason: "Connection has no valid Twilio credential" };
    }

    const signature = request.headers["x-twilio-signature"] || "";
    if (!validateTwilioSignature(credential.authToken, signature, request.url, params)) {
      return { kind: "rejected", reason: "Invalid Twilio signature" };
    }

    const ctx = await buildChannelCredentialContext(resolved);

    const event = buildMessageReceivedEvent({
      businessId: ctx.businessId,
      channel: "sms",
      connectionId: resolved.connectionId,
      externalId: messageSid,
      payload: { text: body, customerName: "SMS User", customerContact: from },
    });

    const registration = await registerInboundEvent(ctx, {
      source: "sms",
      externalEventId: messageSid,
      eventType: event.type,
      correlationId: event.correlationId,
      event,
    });

    if (registration.isDuplicate) return { kind: "duplicate" };

    return { kind: "new", ctx, connectionId: resolved.connectionId, event, receiptId: registration.receiptId };
  }

  async sendMessage(ctx: TenantContext, connectionId: string, to: string, content: OutboundContent): Promise<SendResult> {
    const credential = await resolveChannelCredential(connectionId, TwilioCredentialSchema);
    if (!credential) return { success: false, error: "Connection has no valid Twilio credential" };

    try {
      const { default: twilio } = await import("twilio");
      const client = twilio(credential.accountSid, credential.authToken);
      await client.messages.create({ body: content.text, from: credential.phoneNumber, to });
      return { success: true };
    } catch (error) {
      logger.error("[SmsAdapter] Failed to send message:", error);
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  async getStatus(ctx: TenantContext, connectionId: string): Promise<ChannelStatus> {
    const db = getScopedPrisma(ctx);
    const connection = await db.channelConnection.findUnique({ where: { id: connectionId } });
    if (!connection?.isActive || !connection.credentialRef) {
      return { connected: false, detail: "Not configured" };
    }
    return { connected: true, detail: "Stateless HTTP channel — connected once credentials exist." };
  }
}

export const smsAdapter = new SmsAdapter();
registerChannelAdapter("sms", smsAdapter);
