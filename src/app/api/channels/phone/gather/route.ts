import { NextRequest, NextResponse } from "next/server";
import { handleSpeechInput } from "@/lib/channels/phone";
import { validateTwilioSignature, getTwilioAuthToken } from "@/lib/twilio-verify";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const params: Record<string, string> = {};
    formData.forEach((value, key) => {
      params[key] = String(value);
    });

    // Validate Twilio signature
    const authToken = await getTwilioAuthToken();
    if (authToken) {
      const signature = request.headers.get("x-twilio-signature") || "";
      const url = request.url;
      if (!validateTwilioSignature(authToken, signature, url, params)) {
        logger.warn("[Phone] Invalid Twilio signature on gather");
        return new NextResponse("Forbidden", { status: 403 });
      }
    }

    const speechResult = params.SpeechResult || "";
    const conversationId = request.nextUrl.searchParams.get("conversationId") || "";
    const callSid = request.nextUrl.searchParams.get("callSid") || params.CallSid || "";

    const twiml = await handleSpeechInput(speechResult, conversationId, callSid);

    return new NextResponse(twiml, {
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
