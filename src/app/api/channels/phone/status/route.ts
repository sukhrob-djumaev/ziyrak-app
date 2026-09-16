import { NextRequest, NextResponse } from "next/server";
import { handleCallEnd } from "@/lib/channels/phone";
import { validateTwilioSignature, getTwilioAuthToken } from "@/lib/twilio-verify";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const params: Record<string, string> = {};
    formData.forEach((value, key) => {
      params[key] = String(value);
    });

    const authToken = await getTwilioAuthToken();
    if (authToken) {
      const signature = request.headers.get("x-twilio-signature") || "";
      if (!validateTwilioSignature(authToken, signature, request.url, params)) {
        logger.warn("[Phone] Invalid Twilio signature on status callback");
        return new NextResponse("Forbidden", { status: 403 });
      }
    }

    const callSid = params.CallSid || "";
    const callDuration = parseInt(params.CallDuration || "0") || 0;
    const callStatus = params.CallStatus || "";

    if (callStatus === "completed" || callStatus === "failed" || callStatus === "no-answer") {
      await handleCallEnd(callSid, callDuration);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error("[Phone] Failed to handle call status:", error);
    return NextResponse.json({ ok: true });
  }
}
