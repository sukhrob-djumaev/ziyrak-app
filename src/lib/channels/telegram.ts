import { prisma } from "@/lib/prisma/raw-client";
import { chat, createNewConversation } from "@/lib/ai/engine";
import { resolveCustomer } from "@/lib/customers/customer-resolver";
import { logger } from "@/lib/observability/logger";
import { getDefaultBusinessContext } from "@/lib/tenancy/default-business";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    text?: string;
    date: number;
  };
}

async function getTelegramToken(): Promise<string> {
  const settings = await prisma.settings.findFirst({
    select: { telegramBotToken: true },
  });
  return settings?.telegramBotToken || "";
}

/**
 * Handle incoming Telegram webhook update.
 */
export async function handleTelegramUpdate(update: TelegramUpdate): Promise<string | null> {
  const message = update.message;
  if (!message?.text) return null;

  try {
    const chatId = String(message.chat.id);
    const userName = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
    const contact = message.from.username ? `@${message.from.username}` : chatId;

    // See whatsapp.ts's identical comment — Phase 2 runtime-isolation
    // audit finding: no per-connection inbound tenant resolution exists
    // yet (Phase 5), so this explicitly scopes to the Default Business.
    const ctx = await getDefaultBusinessContext();
    const db = getScopedPrisma(ctx);

    const customerId = await resolveCustomer(ctx, "telegram", contact, userName);

    let conversation = await db.conversation.findFirst({
      where: {
        channel: "telegram",
        status: { in: ["active", "escalated"] },
        OR: [{ customerId }, { customerContact: contact }],
      },
    });

    if (!conversation) {
      conversation = await createNewConversation(ctx, "telegram", userName, contact, customerId);
    }

    const aiResponse = await chat(ctx, conversation.id, message.text);

    // Send reply via Telegram API
    const token = await getTelegramToken();
    if (token) {
      await sendTelegramMessage(token, message.chat.id, aiResponse);
    }

    return aiResponse;
  } catch (error) {
    logger.error("[Telegram] Failed to process update:", error);
    return null;
  }
}

/**
 * Send a message via Telegram Bot API.
 */
async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
        }),
      }
    );

    return response.ok;
  } catch (error) {
    logger.error("[Telegram] Failed to send message:", error);
    return false;
  }
}

/**
 * Set up Telegram webhook URL.
 */
export async function setupTelegramWebhook(
  botToken: string,
  webhookUrl: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl }),
      }
    );

    const data = await response.json();
    return data.ok === true;
  } catch (error) {
    logger.error("[Telegram] Failed to set webhook:", error);
    return false;
  }
}
