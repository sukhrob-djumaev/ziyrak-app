import { NextRequest, NextResponse } from "next/server";
import { phoneAdapter } from "@/lib/channels/phone-adapter";
import { generateTwiMLSay, generateTwiMLHold } from "@/lib/channels/phone";
import { normalizeFormRequest } from "@/lib/channels/http-request";
import { enqueueInboundProcessing } from "@/lib/events/dispatch";
import { logger } from "@/lib/observability/logger";

/**
 * PLAN.md §17.4/§17.6/§46.5 (acceptance-audit correction) — verify →
 * resolve → dedupe → persist → enqueue → ACK, the same shape as every
 * other real channel. Twilio's `<Gather>` action webhook is synchronous
 * by protocol (Twilio blocks the call on the TwiML in this response, with
 * a hard ~15s timeout before retry/fallback), but that response no longer
 * has to contain the AI's answer — it parks the call with hold TwiML,
 * and `PhoneAdapter.sendMessage()` pushes the real answer into the
 * still-live call via Twilio's Calls resource `update()` once the
 * enqueued job completes (see `phone-adapter.ts`'s own header comment).
 */
export async function POST(request: NextRequest) {
  try {
    const conversationId = request.nextUrl.searchParams.get("conversationId") || "";
    const normalized = await normalizeFormRequest(request, { conversationId });
    const result = await phoneAdapter.validateInbound(normalized);

    if (result.kind === "rejected") {
      if (result.reason === "invalid_signature") {
        return new NextResponse("Forbidden", { status: 403 });
      }
      return new NextResponse(generateTwiMLSay("I didn't catch that. Could you please repeat?", request.url), {
        headers: { "Content-Type": "text/xml" },
      });
    }

    if (result.kind === "new") {
      await enqueueInboundProcessing(result.ctx, result.receiptId, result.event);
    }

    // "duplicate" and "new" both ACK with the same hold TwiML — Twilio
    // must never see a different response for a redelivery than for the
    // original (§17.4). The AI's actual answer arrives later via
    // PhoneAdapter.sendMessage()'s call-update, not this response.
    return new NextResponse(generateTwiMLHold("One moment please, let me look that up for you.", request.url), {
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    logger.error("[Phone] Failed to handle speech input:", error);
    return new NextResponse(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>An error occurred. Please try again.</Say></Response>',
      { headers: { "Content-Type": "text/xml" } }
    );
  }
}
