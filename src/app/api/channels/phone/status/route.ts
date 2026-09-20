import { NextRequest, NextResponse } from "next/server";
import { handleCallEnd } from "@/lib/channels/phone-adapter";
import { normalizeFormRequest } from "@/lib/channels/http-request";
import { logger } from "@/lib/observability/logger";

export async function POST(request: NextRequest) {
  try {
    const normalized = await normalizeFormRequest(request);
    const result = await handleCallEnd(normalized);

    if (result.kind === "rejected") {
      return new NextResponse("Forbidden", { status: result.status });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error("[Phone] Failed to handle call status:", error);
    return NextResponse.json({ ok: true });
  }
}
