import { findConnectionById, resolveChannelCredential, buildChannelCredentialContext } from "@/lib/identity/channel-credential-auth";
import { TelegramCredentialSchema } from "@/lib/secrets";
import { buildMessageReceivedEvent } from "@/lib/events/types";
import { registerInboundEvent } from "@/lib/events/inbound-receipt";
import type { ChannelAdapter, ChannelStatus, NormalizedInboundRequest, OutboundContent, SendResult, ValidateInboundResult } from "./types";
import { registerChannelAdapter } from "./registry";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { TenantContext } from "@/lib/tenancy/context";
import { logger } from "@/lib/observability/logger";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; last_name?: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
    date: number;
  };
}

/**
 * PLAN.md §19.2/§32/§46.5 — wraps `telegram.ts`'s Bot API logic behind the
 * `ChannelAdapter` contract. Telegram has no per-request signature (unlike
 * Twilio's HMAC) — the webhook URL itself carries the `connectionId`
 * (`/api/channels/telegram/[connectionId]`, since Telegram gives no
 * provider-side identifier for "which bot" an update belongs to in the
 * payload), and the `X-Telegram-Bot-Api-Secret-Token` header (set via
 * `setWebhook`'s own `secret_token` param) is verified against that
 * connection's stored secret — the "secret-token webhook verification"
 * §46.5 names as a real, previously-undocumented gap. Dedup key:
 * Telegram's own `update_id` (§17.4/§19.2 — stable and provider-issued).
 */
export class TelegramAdapter implements ChannelAdapter<NormalizedInboundRequest> {
  readonly type = "telegram";
  readonly capabilities = {
    supportsMedia: false,
    supportsTemplates: false,
    supportsTypingIndicator: false,
    supportsDeliveryReceipts: false,
    supportsMultipleConnections: true,
  };

  async validateInbound(request: NormalizedInboundRequest): Promise<ValidateInboundResult> {
    const connectionId = request.routeParams.connectionId;
    if (!connectionId) return { kind: "rejected", reason: "Missing connectionId in webhook path" };

    const resolved = await findConnectionById("telegram", connectionId);
    if (!resolved) return { kind: "rejected", reason: "No active ChannelConnection for this id" };

    const credential = await resolveChannelCredential(resolved.connectionId, TelegramCredentialSchema);
    if (!credential) return { kind: "rejected", reason: "Connection has no valid Telegram credential" };

    if (!credential.secretToken) {
      return { kind: "rejected", reason: "Connection has no secret token registered — re-run webhook setup" };
    }

    const presentedSecret = request.headers["x-telegram-bot-api-secret-token"] || "";
    if (presentedSecret !== credential.secretToken) {
      return { kind: "rejected", reason: "Invalid or missing secret token" };
    }

    const update = request.json as TelegramUpdate | undefined;
    if (!update?.message?.text) {
      // Non-text updates (edits, stickers, channel posts, ...) are not
      // this phase's scope — acknowledged as "rejected" so the route still
      // returns Telegram's required 200 OK without enqueuing anything.
      return { kind: "rejected", reason: "No text message in update" };
    }
    const message = update.message;
    if (!message.text) {
      return { kind: "rejected", reason: "No text message in update" };
    }
    const messageText = message.text;

    const ctx = await buildChannelCredentialContext(resolved);
    // Always the numeric chat id, never `@username` — Telegram's
    // `sendMessage` only accepts `@username` for public channels, not a
    // DM with an individual user, so the chat id must be what
    // `processInboundMessage`'s generic `adapter.sendMessage(..., to, ...)`
    // step (which has no per-channel special case) receives as `to`.
    const contact = String(message.chat.id);
    const usernameSuffix = message.from.username ? ` (@${message.from.username})` : "";
    const customerName = ([message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || "Telegram User") + usernameSuffix;

    const event = buildMessageReceivedEvent({
      businessId: ctx.businessId,
      channel: "telegram",
      connectionId: resolved.connectionId,
      externalId: String(update.update_id),
      payload: { text: messageText, customerName, customerContact: contact },
    });

    const registration = await registerInboundEvent(ctx, {
      source: "telegram",
      externalEventId: String(update.update_id),
      eventType: event.type,
      correlationId: event.correlationId,
      event,
    });

    if (registration.isDuplicate) return { kind: "duplicate" };

    return { kind: "new", ctx, connectionId: resolved.connectionId, event, receiptId: registration.receiptId };
  }

  async sendMessage(ctx: TenantContext, connectionId: string, to: string, content: OutboundContent): Promise<SendResult> {
    const credential = await resolveChannelCredential(connectionId, TelegramCredentialSchema);
    if (!credential) return { success: false, error: "Connection has no valid Telegram credential" };

    // `to` is always the numeric chat id, stringified (see `contact` above).
    try {
      const response = await fetch(`https://api.telegram.org/bot${credential.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: Number(to), text: content.text, parse_mode: "Markdown" }),
      });
      if (!response.ok) return { success: false, error: `Telegram API returned ${response.status}` };
      return { success: true };
    } catch (error) {
      logger.error("[TelegramAdapter] Failed to send message:", error);
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  async getStatus(ctx: TenantContext, connectionId: string): Promise<ChannelStatus> {
    const db = getScopedPrisma(ctx);
    const connection = await db.channelConnection.findUnique({ where: { id: connectionId } });
    if (!connection?.isActive || !connection.credentialRef) {
      return { connected: false, detail: "Not configured" };
    }
    return { connected: true };
  }
}

export const telegramAdapter = new TelegramAdapter();
registerChannelAdapter("telegram", telegramAdapter);

/**
 * Registers this connection's webhook URL (including its `connectionId`,
 * since that's how `validateInbound` above resolves "which bot") and a
 * fresh `secret_token` with Telegram's Bot API. Not wired to any route yet
 * (channel-connection setup UI is §46.5 task 9's minimal scope) — a
 * pre-existing gap, carried forward rather than expanded, since building
 * that UI flow is not named in this phase's task list.
 */
export async function setupTelegramWebhook(botToken: string, connectionId: string, secretToken: string): Promise<boolean> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!baseUrl) {
    logger.error("[TelegramAdapter] NEXT_PUBLIC_APP_URL is not set, cannot register webhook");
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: `${baseUrl}/api/channels/telegram/${connectionId}`,
        secret_token: secretToken,
      }),
    });
    const data = await response.json();
    return data.ok === true;
  } catch (error) {
    logger.error("[TelegramAdapter] Failed to set webhook:", error);
    return false;
  }
}
