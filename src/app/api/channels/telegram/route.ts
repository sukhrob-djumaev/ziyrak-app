import { NextRequest, NextResponse } from "next/server";
import { handleTelegramUpdate } from "@/lib/channels/telegram";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  try {
    const update = await request.json();

    await handleTelegramUpdate(update);

    // Telegram expects 200 OK quickly
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error("[Telegram] Webhook error:", error);
    return NextResponse.json({ ok: true }); // Always 200 for Telegram
  }
}
