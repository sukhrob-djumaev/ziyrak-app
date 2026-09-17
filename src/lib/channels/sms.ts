import { prisma } from "@/lib/prisma/raw-client";
import { chat, createNewConversation } from "@/lib/ai/engine";
import { resolveCustomer } from "@/lib/customer-resolver";
import { logger } from "@/lib/logger";
import { getDefaultBusinessContext } from "@/lib/default-business";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

interface SmsConfig {
  twilioSid: string;
  twilioToken: string;
  twilioPhone: string;
}

async function getSmsConfig(): Promise<SmsConfig | null> {
  const settings = await prisma.settings.findFirst();
  if (!settings?.twilioSid || !settings?.twilioToken || !settings?.twilioPhone) return null;

  return {
    twilioSid: settings.twilioSid,
    twilioToken: settings.twilioToken,
    twilioPhone: settings.twilioPhone,
  };
}

/**
 * Handle incoming SMS message from Twilio webhook.
 */
export async function handleIncomingSms(
  from: string,
  body: string
): Promise<string> {
  try {
    if (!body || !body.trim()) {
      return "Please send a message and we'll be happy to help!";
    }

    // See whatsapp.ts's identical comment — Phase 2 runtime-isolation
    // audit finding: no per-connection inbound tenant resolution exists
    // yet (Phase 5), so this explicitly scopes to the Default Business.
    const ctx = await getDefaultBusinessContext();
    const db = getScopedPrisma(ctx);

    const customerId = await resolveCustomer(ctx, "sms", from, "SMS User");

    let conversation = await db.conversation.findFirst({
      where: {
        channel: "sms",
        status: { in: ["active", "escalated"] },
        OR: [{ customerId }, { customerContact: from }],
      },
    });

    if (!conversation) {
      conversation = await createNewConversation(ctx, "sms", "SMS User", from, customerId);
    }

    const aiResponse = await chat(ctx, conversation.id, body.trim());
    return aiResponse;
  } catch (error) {
    logger.error("[SMS] Failed to process incoming message:", error);
    return "Sorry, we're experiencing issues. Please try again later.";
  }
}

/**
 * Send an outbound SMS via Twilio.
 */
export async function sendSms(
  to: string,
  message: string
): Promise<boolean> {
  const config = await getSmsConfig();
  if (!config) {
    logger.warn("[SMS] Not configured");
    return false;
  }

  try {
    const { default: twilio } = await import("twilio");
    const client = twilio(config.twilioSid, config.twilioToken);

    await client.messages.create({
      body: message,
      from: config.twilioPhone,
      to,
    });

    return true;
  } catch (error) {
    logger.error("[SMS] Failed to send message:", error);
    return false;
  }
}
