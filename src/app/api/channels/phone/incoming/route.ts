import { NextRequest, NextResponse } from "next/server";
import { handleIncomingCall } from "@/lib/channels/phone-adapter";
import { normalizeFormRequest } from "@/lib/channels/http-request";
import { logger } from "@/lib/observability/logger";

export async function POST(request: NextRequest) {
  try {
    const normalized = await normalizeFormRequest(request);
    const result = await handleIncomingCall(normalized);

    if (result.kind === "rejected") {
      return new NextResponse("Forbidden", { status: result.status });
    }

    return new NextResponse(result.twiml, { headers: { "Content-Type": "text/xml" } });
  } catch (error) {
    logger.error("[Phone] Failed to handle incoming call:", error);
    return new NextResponse(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>An error occurred. Please try again later.</Say></Response>',
      { headers: { "Content-Type": "text/xml" } }
    );
  }
}
