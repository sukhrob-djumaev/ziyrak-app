import { NextRequest, NextResponse } from "next/server";
import { phoneAdapter } from "@/lib/channels/phone-adapter";
import { generateTwiMLSay } from "@/lib/channels/phone";
import { normalizeFormRequest } from "@/lib/channels/http-request";
import { processInboundMessage } from "@/lib/conversations/inbound";
import { logger } from "@/lib/observability/logger";

/**
 * PLAN.md §17.5/§46.5 — the one channel leg that legitimately calls
 * `processInboundMessage` synchronously rather than enqueuing (see
 * `PhoneAdapter`'s own header comment): a live call has no way to receive
 * an asynchronous reply, so the AI's response must already be in hand
 * before this route can return TwiML.
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

    if (result.kind === "duplicate") {
      return new NextResponse(generateTwiMLSay("One moment please.", request.url), {
        headers: { "Content-Type": "text/xml" },
      });
    }

    const { response } = await processInboundMessage(result.ctx, result.event);
    return new NextResponse(generateTwiMLSay(response, request.url), {
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
