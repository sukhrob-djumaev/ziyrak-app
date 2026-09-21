import crypto from "crypto";
import { findConnectionById, findConnectionConfig, resolveChannelCredential, buildChannelCredentialContext } from "@/lib/identity/channel-credential-auth";
import { WebChatWidgetCredentialSchema } from "@/lib/secrets";
import { buildMessageReceivedEvent } from "@/lib/events/types";
import { registerInboundEvent } from "@/lib/events/inbound-receipt";
import type { ChannelAdapter, ChannelStatus, NormalizedInboundRequest, SendResult, ValidateInboundResult } from "./types";
import { registerChannelAdapter } from "./registry";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { TenantContext } from "@/lib/tenancy/context";

interface WebChatConnectionConfig {
  allowedOrigins?: string[];
  rateLimitPerMinute?: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 4000;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 200;

interface WebChatMessageBody {
  token?: string;
  clientMessageId?: string;
  /** Client-generated (crypto.randomUUID() in the browser), persisted across a visitor's session — see conversations/inbound.ts's webchat branch. */
  conversationId?: string;
  text?: string;
  customerName?: string;
  customerContact?: string;
}

/**
 * PLAN.md §20.4/§46.5 — the first channel with no legacy code to migrate.
 * Its inbound request carries the `connectionId` in the webhook path
 * (`/api/channels/webchat/[connectionId]/message`, same pattern as
 * Telegram) *and* a publishable `zy_pub_...` token in the body — the token
 * alone is not treated as a global lookup key (§20.4's own design: the
 * token is assumed to be exposed, so it must be scoped by construction,
 * never a bearer-of-unlimited-lookup credential), only as the thing that
 * must exactly match the *named* connection's own stored credential.
 *
 * `sendMessage` is a documented no-op: `chat()` already publishes the
 * assistant's reply on `tenantConversationChannel(businessId,
 * conversationId)` via `RealtimeBus` (`conversations/messaging.ts`'s
 * `notifyNewAssistantMessage`, unconditionally, for every channel) — Web
 * Chat's own "outbound send" *is* that publish (§20.4: "the outbound send
 * and realtime notification concerns naturally converge"), delivered to
 * the widget by the public stream route
 * (`/api/channels/webchat/[connectionId]/stream`), not by a second,
 * separate delivery mechanism here.
 */
export class WebChatAdapter implements ChannelAdapter<NormalizedInboundRequest> {
  readonly type = "webchat";
  readonly capabilities = {
    supportsMedia: false,
    supportsTemplates: false,
    supportsTypingIndicator: false,
    supportsDeliveryReceipts: false,
    supportsMultipleConnections: true,
  };

  /**
   * The verify half shared by the inbound `message` route and the public
   * `stream` route below — both need "is this token, for this
   * connectionId, from this Origin, legitimate" before doing anything else
   * (§14.3: verification before any business logic runs).
   */
  async authenticateWidget(connectionId: string, token: string, origin: string): Promise<TenantContext | null> {
    if (!connectionId || !token) return null;

    const resolved = await findConnectionById("webchat", connectionId);
    if (!resolved) return null;

    const config = (await this.loadConfig(resolved.connectionId)) ?? {};
    if (!originAllowed(origin, config.allowedOrigins)) return null;

    const credential = await resolveChannelCredential(resolved.connectionId, WebChatWidgetCredentialSchema);
    if (!credential) return null;

    if (!timingSafeEqualStrings(token, credential.widgetSecret)) return null;

    return buildChannelCredentialContext(resolved);
  }

  /**
   * CORS headers for the public widget routes (PLAN.md §20.4/§46.7): an
   * `Access-Control-Allow-Origin` is granted only when the caller's `Origin`
   * is on *this connection's own* `allowedOrigins` — never `*`, never a
   * global value — so the browser itself refuses to let a page on any other
   * origin read a response, independent of the server-side origin check.
   * This is not authentication (an attacker's non-browser client can send any
   * `Origin` header); `authenticateWidget` remains the enforcing check.
   */
  async corsHeadersFor(connectionId: string, origin: string): Promise<Record<string, string>> {
    if (!connectionId || !origin) return {};
    const resolved = await findConnectionById("webchat", connectionId);
    if (!resolved) return {};
    const config = (await this.loadConfig(resolved.connectionId)) ?? {};
    if (!originAllowed(origin, config.allowedOrigins)) return {};
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }

  async validateInbound(request: NormalizedInboundRequest): Promise<ValidateInboundResult> {
    const connectionId = request.routeParams.connectionId;
    if (!connectionId) return { kind: "rejected", reason: "Missing connectionId in path" };

    const body = (request.json ?? {}) as WebChatMessageBody;
    if (!body.token || !body.clientMessageId || !body.text?.trim() || !body.conversationId) {
      return { kind: "rejected", reason: "Missing token/clientMessageId/conversationId/text" };
    }

    const origin = request.headers.origin || "";
    const ctx = await this.authenticateWidget(connectionId, body.token, origin);
    if (!ctx) return { kind: "rejected", reason: "Invalid token, origin, or connection" };

    // PLAN.md §46.7 — the widget-supplied ids/text are attacker-controlled by
    // construction (§20.4), so bound them before anything is persisted:
    // `conversationId` becomes a `Conversation` primary key, so it must be a
    // real UUID (what `crypto.randomUUID()` in the widget produces), not an
    // arbitrary string; text/name/contact lengths are capped so one visitor
    // can't push megabytes into a row or a model prompt.
    if (
      !UUID_PATTERN.test(body.conversationId) ||
      body.clientMessageId.length > MAX_ID_LENGTH ||
      body.text.length > MAX_TEXT_LENGTH ||
      (body.customerName && body.customerName.length > MAX_NAME_LENGTH) ||
      (body.customerContact && body.customerContact.length > MAX_ID_LENGTH)
    ) {
      return { kind: "rejected", reason: "Malformed message fields" };
    }

    const customerContact = body.customerContact || `webchat:${body.conversationId}`;

    // A conversation id the visitor presents that already exists must belong
    // to *this* connection and *this* visitor — otherwise anyone who learns a
    // conversation id (a leaked URL, a shared screenshot) could append
    // messages to someone else's thread, or a widget on connection 2 could
    // write into connection 1's conversation within the same business. The
    // scoped client already guarantees a different *business's* conversation
    // is simply not found here.
    const db = getScopedPrisma(ctx);
    const existing = await db.conversation.findUnique({ where: { id: body.conversationId } });
    if (existing) {
      const owningConnectionId = (existing.metadata as Record<string, unknown> | null)?.channelConnectionId;
      if (owningConnectionId !== connectionId || existing.customerContact !== customerContact) {
        return { kind: "rejected", reason: "Conversation does not belong to this visitor/connection" };
      }
    }

    const event = buildMessageReceivedEvent({
      businessId: ctx.businessId,
      channel: "webchat",
      connectionId,
      externalId: body.clientMessageId,
      conversationId: body.conversationId,
      payload: {
        text: body.text.trim(),
        customerName: body.customerName || "Website Visitor",
        customerContact,
      },
    });

    const registration = await registerInboundEvent(ctx, {
      source: "webchat",
      externalEventId: body.clientMessageId,
      eventType: event.type,
      correlationId: event.correlationId,
      event,
    });

    if (registration.isDuplicate) return { kind: "duplicate" };

    return { kind: "new", ctx, connectionId, event, receiptId: registration.receiptId };
  }

  async sendMessage(): Promise<SendResult> {
    return { success: true };
  }

  async getStatus(ctx: TenantContext, connectionId: string): Promise<ChannelStatus> {
    const db = getScopedPrisma(ctx);
    const connection = await db.channelConnection.findUnique({ where: { id: connectionId } });
    if (!connection?.isActive || !connection.credentialRef) {
      return { connected: false, detail: "Not configured" };
    }
    return { connected: true };
  }

  private async loadConfig(connectionId: string): Promise<WebChatConnectionConfig | null> {
    return (await findConnectionConfig(connectionId)) as WebChatConnectionConfig | null;
  }
}

function originAllowed(origin: string, allowedOrigins: string[] | undefined): boolean {
  if (!origin || !allowedOrigins || allowedOrigins.length === 0) return false;
  return allowedOrigins.includes(origin);
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function generateWebChatToken(): string {
  return `zy_pub_${crypto.randomBytes(24).toString("hex")}`;
}

export const webChatAdapter = new WebChatAdapter();
registerChannelAdapter("webchat", webChatAdapter);
