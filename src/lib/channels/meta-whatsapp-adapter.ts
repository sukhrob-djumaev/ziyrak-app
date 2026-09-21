import { findConnectionByConfigField, resolveChannelCredential, buildChannelCredentialContext } from "@/lib/identity/channel-credential-auth";
import { MetaWhatsAppCredentialSchema } from "@/lib/secrets";
import { buildMessageReceivedEvent } from "@/lib/events/types";
import { registerInboundEvent } from "@/lib/events/inbound-receipt";
import type { ChannelAdapter, ChannelStatus, OutboundContent, SendResult, ValidateInboundResult } from "./types";
import { registerChannelAdapter } from "./registry";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { TenantContext } from "@/lib/tenancy/context";
import { validateMetaSignature, getMetaAppSecret } from "./meta-verify";
import { logger } from "@/lib/observability/logger";

const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || "v21.0";

/** The shape a Meta Cloud API webhook payload's `entry[].changes[].value` carries (only the fields this adapter reads). */
interface MetaWebhookValue {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: { profile?: { name?: string }; wa_id?: string }[];
  messages?: {
    from: string;
    id: string;
    timestamp: string;
    type: string;
    text?: { body: string };
  }[];
  statuses?: unknown[];
}

interface MetaWebhookPayload {
  object?: string;
  entry?: { id: string; changes?: { value: MetaWebhookValue; field: string }[] }[];
}

/** Everything `validateInbound` needs — deliberately not `NormalizedInboundRequest` (§19.1's own per-adapter customization allowance): signature verification needs the exact raw body bytes, which a pre-parsed `json` field cannot reconstruct byte-for-byte. */
export interface MetaWebhookRequest {
  headers: Record<string, string>;
  rawBody: string;
}

function extractFirstInboundMessage(payload: MetaWebhookPayload): { value: MetaWebhookValue; message: NonNullable<MetaWebhookValue["messages"]>[number] } | null {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const message = change.value.messages?.[0];
      if (message && message.type === "text" && message.text?.body) {
        return { value: change.value, message };
      }
    }
  }
  return null;
}

/**
 * PLAN.md §20.1/§20.2/§46.7 — the real, production, multi-tenant WhatsApp
 * path: stateless HTTPS to the WhatsApp Business Cloud API. Unlike every
 * other adapter in this codebase, the thing that identifies "which
 * business" is not itself the request's own credential (there is no
 * per-connection secret in the inbound request at all) — Meta's webhook is
 * authenticated once, platform-wide, via `X-Hub-Signature-256` keyed by one
 * shared Ziyrak-owned Meta App Secret (env-configured, never a
 * `ChannelConnection` credential), and only *after* that passes does the
 * payload's own `phone_number_id` resolve to a specific `ChannelConnection`/
 * business (§7.7) — the reverse order from SMS/Telegram, where the
 * connection's own credential *is* the signature key. No Puppeteer, no
 * browser session, no QR code: every method is stateless and this adapter
 * never gates on `assertDefaultBusinessOnly()` (§20.1's whole point).
 *
 * Dedup key: Meta's own `wamid...` message id (§17.4/§19.2 — stable,
 * provider-issued, no fallback heuristic needed, same category as Twilio's
 * `MessageSid`/Telegram's `update_id`).
 */
export class MetaCloudWhatsAppAdapter implements ChannelAdapter<MetaWebhookRequest> {
  readonly type = "whatsapp_cloud";
  readonly capabilities = {
    supportsMedia: false,
    supportsTemplates: false,
    supportsTypingIndicator: false,
    supportsDeliveryReceipts: false,
    supportsMultipleConnections: true,
  };

  async validateInbound(request: MetaWebhookRequest): Promise<ValidateInboundResult> {
    const appSecret = getMetaAppSecret();
    if (!appSecret) {
      return { kind: "rejected", reason: "META_APP_SECRET is not configured on this deployment" };
    }

    const signature = request.headers["x-hub-signature-256"] || "";
    if (!validateMetaSignature(appSecret, signature, request.rawBody)) {
      return { kind: "rejected", reason: "Invalid X-Hub-Signature-256" };
    }

    let payload: MetaWebhookPayload;
    try {
      payload = JSON.parse(request.rawBody) as MetaWebhookPayload;
    } catch {
      return { kind: "rejected", reason: "Malformed JSON body" };
    }

    const found = extractFirstInboundMessage(payload);
    if (!found) {
      // Status callbacks (delivered/read) and non-text message types land
      // here — not this phase's scope (§46.7 task 1 names text messages;
      // delivery-receipt processing is not a named acceptance criterion).
      // Acknowledged as "rejected" so the webhook route still ACKs 200
      // without enqueuing anything, exactly like Telegram's non-text case.
      return { kind: "rejected", reason: "No inbound text message in payload" };
    }

    const { value, message } = found;
    const phoneNumberId = value.metadata?.phone_number_id;
    if (!phoneNumberId) {
      return { kind: "rejected", reason: "Missing phone_number_id in webhook payload" };
    }

    const resolved = await findConnectionByConfigField("whatsapp_cloud", "phoneNumberId", phoneNumberId);
    if (!resolved) {
      return { kind: "rejected", reason: "No active ChannelConnection matches this phone_number_id" };
    }

    const ctx = await buildChannelCredentialContext(resolved);
    const contactProfile = value.contacts?.find((c) => c.wa_id === message.from);
    const customerName = contactProfile?.profile?.name || "WhatsApp User";

    const event = buildMessageReceivedEvent({
      businessId: ctx.businessId,
      channel: "whatsapp_cloud",
      connectionId: resolved.connectionId,
      externalId: message.id,
      occurredAt: new Date(Number(message.timestamp) * 1000).toISOString(),
      payload: { text: message.text!.body, customerName, customerContact: message.from },
    });

    const registration = await registerInboundEvent(ctx, {
      source: "whatsapp_cloud",
      externalEventId: message.id,
      eventType: event.type,
      correlationId: event.correlationId,
      event,
    });

    if (registration.isDuplicate) return { kind: "duplicate" };

    return { kind: "new", ctx, connectionId: resolved.connectionId, event, receiptId: registration.receiptId };
  }

  async sendMessage(ctx: TenantContext, connectionId: string, to: string, content: OutboundContent): Promise<SendResult> {
    // `resolveChannelCredential` reads by id with no tenant check (it has to
    // work for inbound webhooks, before any ctx exists) — so a *send* must
    // itself prove the connection belongs to the acting business before its
    // access token is ever decrypted (§46.7: "one business's credentials can
    // never be used to send another business's response").
    const owned = await getScopedPrisma(ctx).channelConnection.findFirst({ where: { id: connectionId, type: "whatsapp_cloud", isActive: true } });
    if (!owned) return { success: false, error: "No active WhatsApp connection for this business" };

    const credential = await resolveChannelCredential(connectionId, MetaWhatsAppCredentialSchema);
    if (!credential) return { success: false, error: "Connection has no valid Meta WhatsApp credential" };

    // §32.1's SSRF dispatcher is for tenant-*supplied* URLs (webhooks); the
    // Graph API host is fixed platform config, not tenant input, so the
    // same bare-fetch pattern TelegramAdapter/SmsAdapter already use for
    // their own fixed-host provider APIs applies here too — no shared
    // retry/backoff wrapper exists in this codebase for outbound provider
    // calls (confirmed: neither Telegram nor SMS uses one).
    try {
      const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${credential.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential.accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: content.text },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        logger.error("[MetaCloudWhatsAppAdapter] Send failed", { status: response.status, businessId: ctx.businessId, connectionId });
        return { success: false, error: `Meta Cloud API returned ${response.status}: ${errorBody.slice(0, 500)}` };
      }
      return { success: true };
    } catch (error) {
      logger.error("[MetaCloudWhatsAppAdapter] Failed to send message:", error);
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

export const metaCloudWhatsAppAdapter = new MetaCloudWhatsAppAdapter();
registerChannelAdapter("whatsapp_cloud", metaCloudWhatsAppAdapter);
