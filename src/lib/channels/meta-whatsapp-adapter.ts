import { findConnectionByConfigField, resolveChannelCredential, buildChannelCredentialContext } from "@/lib/identity/channel-credential-auth";
import { MetaWhatsAppCredentialSchema } from "@/lib/secrets";
import { buildMessageReceivedEvent } from "@/lib/events/types";
import { registerInboundEvent } from "@/lib/events/inbound-receipt";
import type { ChannelAdapter, ChannelStatus, OutboundContent, SendResult, ValidateInboundResult } from "./types";
import { registerChannelAdapter } from "./registry";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { TenantContext } from "@/lib/tenancy/context";
import { validateMetaSignature } from "./meta-verify";
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
  statuses?: { id?: string; status?: string; errors?: { code?: number; title?: string }[] }[];
}

interface MetaWebhookPayload {
  object?: string;
  entry?: { id: string; changes?: { value: MetaWebhookValue; field: string }[] }[];
}

/** Everything `validateInbound` needs — deliberately not `NormalizedInboundRequest` (§19.1's own per-adapter customization allowance): signature verification needs the exact raw body bytes, which a pre-parsed `json` field cannot reconstruct byte-for-byte. */
export interface MetaWebhookRequest {
  headers: Record<string, string>;
  /** Original wire bytes. String remains accepted for direct adapter callers/tests. */
  rawBody: Buffer | string;
}

export type MetaPhoneNumberIdExtraction =
  | { kind: "one"; phoneNumberId: string }
  | { kind: "none" }
  | { kind: "multiple" }
  | { kind: "malformed" };

function rawBodyBuffer(rawBody: Buffer | string): Buffer {
  return Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
}

/**
 * Reads only the provider routing identifiers needed to choose one HMAC key.
 * This parses untrusted JSON but performs no tenant construction, credential
 * mutation, receipt write, enqueue, AI invocation, or outbound send.
 */
export function extractMetaPhoneNumberIds(rawBody: Buffer | string): MetaPhoneNumberIdExtraction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBodyBuffer(rawBody).toString("utf8"));
  } catch {
    return { kind: "malformed" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "malformed" };
  const entries = (parsed as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return { kind: "malformed" };

  const phoneNumberIds = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { kind: "malformed" };
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) return { kind: "malformed" };
    for (const change of changes) {
      if (!change || typeof change !== "object" || Array.isArray(change)) return { kind: "malformed" };
      const value = (change as { value?: unknown }).value;
      if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "malformed" };
      const metadata = (value as { metadata?: unknown }).metadata;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
      const phoneNumberId = (metadata as { phone_number_id?: unknown }).phone_number_id;
      if (typeof phoneNumberId === "string" && phoneNumberId.length > 0) phoneNumberIds.add(phoneNumberId);
    }
  }

  if (phoneNumberIds.size === 0) return { kind: "none" };
  if (phoneNumberIds.size !== 1) return { kind: "multiple" };
  return { kind: "one", phoneNumberId: phoneNumberIds.values().next().value! };
}

function extractFirstInboundMessage(payload: MetaWebhookPayload): { value: MetaWebhookValue; message: NonNullable<MetaWebhookValue["messages"]>[number] } | null {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const message = change.value.messages?.find((m) => m.type === "text" && m.text?.body);
      if (message) return { value: change.value, message };
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
 * authentication begins with an untrusted-but-side-effect-free extraction of
 * `phone_number_id`, which selects one active `ChannelConnection` and exactly
 * one HMAC key: the connection's own encrypted `appSecret` (a connection
 * without one is rejected). Only a successful
 * verification authorizes tenant context construction or any persistence. No Puppeteer, no
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
    const rawBody = rawBodyBuffer(request.rawBody);
    const candidate = extractMetaPhoneNumberIds(rawBody);
    if (candidate.kind === "malformed") return { kind: "rejected", reason: "Malformed JSON body", authenticated: false };
    if (candidate.kind === "none") return { kind: "rejected", reason: "Missing phone_number_id in webhook payload", authenticated: false };
    if (candidate.kind === "multiple") return { kind: "rejected", reason: "Multiple phone_number_id values in webhook payload", authenticated: false };

    const resolved = await findConnectionByConfigField("whatsapp_cloud", "phoneNumberId", candidate.phoneNumberId);
    if (!resolved) {
      return { kind: "rejected", reason: "No active ChannelConnection matches this phone_number_id", authenticated: false };
    }

    const credential = await resolveChannelCredential(resolved.connectionId, MetaWhatsAppCredentialSchema);
    if (!credential) {
      return { kind: "rejected", reason: "Connection has no valid Meta WhatsApp credential", authenticated: false };
    }

    // Do not try a pool of secrets: this candidate connection's own encrypted
    // App Secret is the only permitted key. There is no platform-wide fallback,
    // so no single shared secret can forge events for several tenants.
    const appSecret = credential.appSecret;
    if (!appSecret) return { kind: "rejected", reason: "No Meta App Secret is configured for this connection", authenticated: false };

    const signature = request.headers["x-hub-signature-256"] || "";
    if (!validateMetaSignature(appSecret, signature, rawBody)) {
      return { kind: "rejected", reason: "Invalid X-Hub-Signature-256", authenticated: false };
    }

    let payload: MetaWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as MetaWebhookPayload;
    } catch {
      // The extraction above successfully parsed the same bytes, but keep a
      // defensive fail-closed guard should parsing ever change.
      return { kind: "rejected", reason: "Malformed JSON body", authenticated: false };
    }

    const found = extractFirstInboundMessage(payload);
    if (!found) {
      // A failed delivery status is the only place Meta says why a reply
      // never reached the sender (e.g. 131031 account locked). Log the code
      // and title only — never the recipient or any message content.
      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          for (const status of change.value.statuses ?? []) {
            if (status.status !== "failed") continue;
            logger.warn("[MetaWhatsApp] Outbound delivery failed", {
              connectionId: resolved.connectionId,
              businessId: resolved.businessId,
              errorCodes: (status.errors ?? []).map((e) => e.code),
              errorTitle: status.errors?.[0]?.title,
            });
          }
        }
      }
      // Status callbacks (delivered/read) and non-text message types land
      // here — not this phase's scope (§46.7 task 1 names text messages;
      // delivery-receipt processing is not a named acceptance criterion).
      // Acknowledged as "rejected" so the webhook route still ACKs 200
      // without enqueuing anything, exactly like Telegram's non-text case.
      return { kind: "rejected", reason: "No inbound text message in payload", authenticated: true };
    }

    const { value, message } = found;
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
        logger.error("[MetaCloudWhatsAppAdapter] Send failed", undefined, {
          status: response.status,
          businessId: ctx.businessId,
          connectionId,
        });
        return { success: false, error: `Meta Cloud API returned ${response.status}: ${errorBody.slice(0, 500)}` };
      }

      // A Graph 2xx means Meta accepted the request, not that the recipient
      // has seen it. Keep the provider message id for acceptance evidence,
      // but never log credential/header/recipient/content data.
      const responseBody = (await response.json().catch(() => null)) as { messages?: { id?: string }[] } | null;
      logger.info("[MetaCloudWhatsAppAdapter] Send accepted", {
        status: response.status,
        metaMessageId: responseBody?.messages?.[0]?.id ?? null,
        sentAt: new Date().toISOString(),
        businessId: ctx.businessId,
        connectionId,
      });
      return { success: true };
    } catch (error) {
      logger.error("[MetaCloudWhatsAppAdapter] Failed to send message:", error, {
        businessId: ctx.businessId,
        connectionId,
      });
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
