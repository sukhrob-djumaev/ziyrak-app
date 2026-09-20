import { NextRequest, NextResponse } from "next/server";
import { smsAdapter } from "@/lib/channels/sms-adapter";
import { normalizeFormRequest } from "@/lib/channels/http-request";
import { enqueueInboundProcessing } from "@/lib/events/dispatch";
import { logger } from "@/lib/observability/logger";

/**
 * PLAN.md §17.6/§19.2/§46.5 — verify → resolve → dedupe → persist → enqueue
 * → ACK. Never runs `chat()`/`processInboundMessage()` inline: the actual
 * reply is sent later, asynchronously, via `SmsAdapter.sendMessage()`
 * (Twilio's outbound REST API), not through this response's TwiML body —
 * this is what lets a slow AI call never risk a Twilio webhook timeout.
 */
export async function POST(request: NextRequest) {
  try {
    const normalized = await normalizeFormRequest(request);
    const result = await smsAdapter.validateInbound(normalized);

    if (result.kind === "rejected") {
      logger.warn("[SMS] Inbound request rejected", { reason: result.reason });
      return new NextResponse("Forbidden", { status: 403 });
    }

    if (result.kind === "new") {
      await enqueueInboundProcessing(result.ctx, result.receiptId, result.event);
    }

    // "duplicate" and "new" both ACK identically — Twilio must never see a
    // different response for a redelivery than for the original (§17.4).
    return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    logger.error("[SMS] Failed to handle incoming SMS:", error);
    return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
      headers: { "Content-Type": "text/xml" },
    });
  }
}
