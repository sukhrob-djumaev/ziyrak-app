import { Client, LocalAuth, Message } from "whatsapp-web.js";
import * as qrcode from "qrcode";
import { logger } from "@/lib/observability/logger";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { assertDefaultBusinessOnly } from "@/lib/tenancy/default-business";
import { AppError } from "@/lib/observability/errors";
import type { TenantContext } from "@/lib/tenancy/context";
import { buildMessageReceivedEvent } from "@/lib/events/types";
import { registerInboundEvent } from "@/lib/events/inbound-receipt";
import { enqueueInboundProcessing } from "@/lib/events/dispatch";
import type { ChannelAdapter, ChannelStatus, OutboundContent, SendResult, ValidateInboundResult } from "./types";
import { registerChannelAdapter } from "./registry";

/**
 * PLAN.md §20.1-20.2/§46.5 — `whatsapp-web.js` drives one shared,
 * process-global Puppeteer session; it is explicitly NOT the production
 * multi-tenant WhatsApp path (§20.1 — that's `MetaCloudWhatsAppAdapter`,
 * Phase 7). This adapter is gated to one internal dev/demo business (the
 * Default Business stands in for that role — the platform simply never
 * offers this adapter as a selectable option to a real tenant, matching
 * §20.2's own wording) via `assertDefaultBusinessOnly()`, the same
 * fail-closed guard Phase 2 already established for exactly this reason.
 *
 * `sessionOwner` replaces the old, implicit `getDefaultBusinessContext()`
 * call inside the message handler: the business/connection that actually
 * called `connect()` is remembered explicitly, so the choice is visible at
 * the one call site that makes it (§14.3's own principle) rather than
 * hardcoded inside the handler.
 */
let whatsappClient: Client | null = null;
let initPromise: Promise<void> | null = null;
let currentQR: string | null = null;
let connectionStatus: "disconnected" | "qr_ready" | "connecting" | "connected" | "error" = "disconnected";
let statusMessage = "";
// WhatsApp Web replays unread/backlog messages through the same 'message' event
// used for genuinely new messages. Without this, every reconnect re-triggers AI
// auto-replies to old messages already in a contact's chat history.
let readySince = 0;
let sessionOwner: { ctx: TenantContext; connectionId: string } | null = null;

export function getWhatsAppStatus() {
  return {
    status: connectionStatus,
    qr: currentQR,
    message: statusMessage,
  };
}

const WHATSAPP_WEB_FEATURE = "WhatsApp Web (internal dev/demo channel)";

/**
 * PLAN.md §20.2/§46.7 — the deployment-level switch for this dev/demo-only
 * adapter (the runbook's "leave `NEXT_PUBLIC_ENABLE_WHATSAPP_WEB` unset in
 * production"). The same flag that shows the dashboard card, read here too so
 * the server — not only the browser — refuses the feature when it is off.
 */
export function isWhatsAppWebEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ENABLE_WHATSAPP_WEB === "true";
}

/**
 * PLAN.md §20.2 — every entry point into the shared session (status/QR,
 * connect, disconnect) requires both: the feature enabled on this deployment,
 * and the caller being the designated dev/demo business
 * (`assertDefaultBusinessOnly`). The status/QR is not harmless read-only
 * data: scanning the QR links the scanner's WhatsApp account into the session
 * the designated business owns.
 */
async function assertWhatsAppWebAccess(ctx: TenantContext): Promise<void> {
  if (!isWhatsAppWebEnabled()) {
    throw new AppError(404, "NOT_FOUND", "WhatsApp Web is not enabled on this deployment.");
  }
  await assertDefaultBusinessOnly(ctx, WHATSAPP_WEB_FEATURE);
}

/** The shared session's status (including its QR code), for the designated dev/demo business only. */
export async function getWhatsAppWebStatus(ctx: TenantContext) {
  await assertWhatsAppWebAccess(ctx);
  return getWhatsAppStatus();
}

async function updateConnectionStatus(owner: { ctx: TenantContext; connectionId: string }, isActive: boolean, status: string) {
  try {
    const db = getScopedPrisma(owner.ctx);
    await db.channelConnection.update({ where: { id: owner.connectionId }, data: { isActive, status } });
  } catch (error) {
    logger.error("[WhatsApp] Failed to update ChannelConnection status:", error);
  }
}

export async function initWhatsApp(ctx: TenantContext, connectionId: string): Promise<void> {
  if (whatsappClient) {
    logger.info("[WhatsApp] Client already exists");
    return;
  }

  if (initPromise) {
    logger.info("[WhatsApp] Initialization already in progress");
    return initPromise;
  }

  sessionOwner = { ctx, connectionId };
  connectionStatus = "connecting";
  statusMessage = "Initializing WhatsApp client...";

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: ".wwebjs_auth" }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  });

  client.on("qr", async (qr: string) => {
    logger.info("[WhatsApp] QR code received");
    currentQR = await qrcode.toDataURL(qr);
    connectionStatus = "qr_ready";
    statusMessage = "Scan the QR code with WhatsApp on your phone";
  });

  client.on("ready", async () => {
    logger.info("[WhatsApp] Client is ready");
    // PLAN.md §2.5/§20.2's exact fix: assigned here, inside the "ready"
    // handler, not after `client.initialize()`'s own promise resolves —
    // "ready" firing IS the definition of "safe to send", and the two can
    // race the other way around, leaving `sendWhatsAppMessage` seeing a
    // null `whatsappClient` and silently no-op-ing on a message that
    // genuinely arrived after the session came online.
    whatsappClient = client;
    currentQR = null;
    connectionStatus = "connected";
    statusMessage = "Connected to WhatsApp";
    readySince = Math.floor(Date.now() / 1000);

    if (sessionOwner) await updateConnectionStatus(sessionOwner, true, "connected");
  });

  client.on("authenticated", () => {
    logger.info("[WhatsApp] Authenticated");
    connectionStatus = "connecting";
    statusMessage = "Authenticated, loading chats...";
  });

  client.on("auth_failure", (message: string) => {
    logger.error(`[WhatsApp] Auth failure: ${message}`);
    connectionStatus = "error";
    statusMessage = `Authentication failed: ${message}`;
  });

  client.on("disconnected", async (reason: string) => {
    logger.info(`[WhatsApp] Disconnected: ${reason}`);
    connectionStatus = "disconnected";
    statusMessage = `Disconnected: ${reason}`;
    whatsappClient = null;
    readySince = 0;

    if (sessionOwner) await updateConnectionStatus(sessionOwner, false, "disconnected");
    sessionOwner = null;
  });

  client.on("message", async (message: Message) => {
    try {
      if (message.fromMe) return;

      // Ignore backlog/unread messages replayed during sync - only react to
      // messages that arrived after this session actually came online.
      if (message.timestamp < readySince) {
        logger.info("[WhatsApp] Skipping backlog message from before connection", {
          from: message.from,
          timestamp: message.timestamp,
        });
        return;
      }

      const result = await whatsAppWebAdapter.validateInbound(message);
      if (result.kind === "rejected") {
        logger.warn("[WhatsApp] Inbound message rejected", { reason: result.reason });
        return;
      }
      if (result.kind === "duplicate") return;

      await enqueueInboundProcessing(result.ctx, result.receiptId, result.event);
    } catch (error) {
      logger.error("[WhatsApp] Failed to process message:", error);
    }
  });

  initPromise = (async () => {
    try {
      await client.initialize();
    } catch (error) {
      logger.error("[WhatsApp] Failed to initialize client:", error);
      connectionStatus = "error";
      statusMessage = error instanceof Error ? error.message : "Failed to initialize WhatsApp client";
      await client.destroy().catch(() => {});
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

export async function disconnectWhatsApp(): Promise<void> {
  if (whatsappClient) {
    await whatsappClient.destroy();
    whatsappClient = null;
    currentQR = null;
    connectionStatus = "disconnected";
    statusMessage = "Disconnected";
  }
}

export async function sendWhatsAppMessage(
  to: string,
  message: string
): Promise<boolean> {
  if (!whatsappClient || connectionStatus !== "connected") {
    return false;
  }

  const chatId = to.includes("@c.us") ? to : `${to}@c.us`;
  await whatsappClient.sendMessage(chatId, message);
  return true;
}

/**
 * PLAN.md §19.2/§46.5 — the `ChannelAdapter` wrapper around the
 * process-global session above. Dedup key: whatsapp-web.js's own
 * `message.id._serialized` (stable and provider-issued) where present,
 * falling back to a `(from, timestamp)` composite for the rare message
 * shape that lacks one — a documented heuristic per §17.4's own allowance.
 */
export class WhatsAppWebAdapter implements ChannelAdapter<Message> {
  readonly type = "whatsapp";
  readonly capabilities = {
    supportsMedia: true,
    supportsTemplates: false,
    supportsTypingIndicator: false,
    supportsDeliveryReceipts: false,
    supportsMultipleConnections: false,
  };

  async validateInbound(message: Message): Promise<ValidateInboundResult> {
    if (!sessionOwner) return { kind: "rejected", reason: "No active WhatsApp Web session" };
    const { ctx, connectionId } = sessionOwner;

    const contact = await message.getContact();
    const customerName = contact.pushname || contact.name || "Unknown";
    const customerContact = message.from;

    let messageContent = message.body;
    if (message.hasMedia) {
      const media = await message.downloadMedia();
      if (media) {
        const mediaType = media.mimetype.split("/")[0];
        messageContent = `[${mediaType} attachment: ${media.filename || "media"}] ${message.body || ""}`;
        if (mediaType === "audio") {
          messageContent = `[Voice message received] ${message.body || ""}`;
        }
      }
    }

    const externalId = message.id?._serialized || `${customerContact}:${message.timestamp}`;

    const event = buildMessageReceivedEvent({
      businessId: ctx.businessId,
      channel: "whatsapp",
      connectionId,
      externalId,
      payload: { text: messageContent, customerName, customerContact },
    });

    const registration = await registerInboundEvent(ctx, {
      source: "whatsapp",
      externalEventId: externalId,
      eventType: event.type,
      correlationId: event.correlationId,
      event,
    });

    if (registration.isDuplicate) return { kind: "duplicate" };

    return { kind: "new", ctx, connectionId, event, receiptId: registration.receiptId };
  }

  async sendMessage(ctx: TenantContext, _connectionId: string, to: string, content: OutboundContent): Promise<SendResult> {
    // Only the business that (gated) connected the shared session may send
    // through it — an ordinary business's own "whatsapp" connection row must
    // never borrow the designated dev/demo business's WhatsApp number.
    if (!isWhatsAppWebEnabled() || sessionOwner?.ctx.businessId !== ctx.businessId) {
      return { success: false, error: "WhatsApp Web is not available for this business" };
    }
    const sent = await sendWhatsAppMessage(to, content.text);
    return sent ? { success: true } : { success: false, error: "WhatsApp Web client is not connected" };
  }

  async getStatus(ctx: TenantContext): Promise<ChannelStatus> {
    const status = await getWhatsAppWebStatus(ctx);
    return { connected: status.status === "connected", detail: status.message };
  }

  async connect(ctx: TenantContext, connectionId: string): Promise<void> {
    await assertWhatsAppWebAccess(ctx);
    await initWhatsApp(ctx, connectionId);
  }

  async disconnect(ctx: TenantContext): Promise<void> {
    // Same gate as connect() — without it, any authenticated business could
    // tear down the shared session another business's inbound WhatsApp
    // messages depend on (the exact Phase 2 finding this guard exists for).
    await assertWhatsAppWebAccess(ctx);
    await disconnectWhatsApp();
  }
}

export const whatsAppWebAdapter = new WhatsAppWebAdapter();
registerChannelAdapter("whatsapp", whatsAppWebAdapter);
