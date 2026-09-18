import { Client, LocalAuth, Message } from "whatsapp-web.js";
import * as qrcode from "qrcode";
import { prisma } from "@/lib/prisma/raw-client";
import { chat, createNewConversation } from "@/lib/ai/engine";
import { logger } from "@/lib/observability/logger";
import { resolveCustomer } from "@/lib/customers/customer-resolver";
import { getDefaultBusinessContext } from "@/lib/tenancy/default-business";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

let whatsappClient: Client | null = null;
let currentQR: string | null = null;
let connectionStatus: "disconnected" | "qr_ready" | "connecting" | "connected" | "error" = "disconnected";
let statusMessage = "";

export function getWhatsAppStatus() {
  return {
    status: connectionStatus,
    qr: currentQR,
    message: statusMessage,
  };
}

export async function initWhatsApp(): Promise<void> {
  if (whatsappClient) {
    logger.info("[WhatsApp] Client already exists");
    return;
  }

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
    currentQR = null;
    connectionStatus = "connected";
    statusMessage = "Connected to WhatsApp";

    await prisma.channel.upsert({
      where: { type: "whatsapp" },
      update: { isActive: true, status: "connected" },
      create: { type: "whatsapp", isActive: true, status: "connected" },
    });
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

    await prisma.channel.upsert({
      where: { type: "whatsapp" },
      update: { isActive: false, status: "disconnected" },
      create: { type: "whatsapp", isActive: false, status: "disconnected" },
    });
  });

  client.on("message", async (message: Message) => {
    try {
      if (message.fromMe) return;

      const contact = await message.getContact();
      const customerName = contact.pushname || contact.name || "Unknown";
      const customerContact = message.from;

      // Phase 2 runtime-isolation audit finding: this inbound handler has
      // no way to resolve "which business" yet — there is no
      // ChannelConnection-based inbound identification (§14.3, Phase 5).
      // getDefaultBusinessContext() makes that single-tenant limitation an
      // explicit, visible choice at this call site rather than an implicit
      // fallback buried inside chat()/resolveCustomer().
      const ctx = await getDefaultBusinessContext();
      const db = getScopedPrisma(ctx);

      // Resolve customer identity across channels
      const customerId = await resolveCustomer(ctx, "whatsapp", customerContact, customerName);

      // Find or create conversation
      let conversation = await db.conversation.findFirst({
        where: {
          channel: "whatsapp",
          status: { in: ["active", "escalated"] },
          OR: [
            { customerId },
            { customerContact },
          ],
        },
      });

      if (!conversation) {
        conversation = await createNewConversation(
          ctx,
          "whatsapp",
          customerName,
          customerContact,
          customerId
        );
      }

      let messageContent = message.body;

      // Handle media messages
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

      // Get AI response
      const aiResponse = await chat(ctx, conversation.id, messageContent);

      // Send response back via WhatsApp
      await message.reply(aiResponse);
    } catch (error) {
      logger.error("[WhatsApp] Failed to process message:", error);
    }
  });

  whatsappClient = client;
  await client.initialize();
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
