import { NextRequest, NextResponse } from "next/server";
import { metaCloudWhatsAppAdapter } from "@/lib/channels/meta-whatsapp-adapter";
import { getMetaWebhookVerifyToken } from "@/lib/channels/meta-verify";
import { enqueueInboundProcessing } from "@/lib/events/dispatch";
import { logger } from "@/lib/observability/logger";

/**
 * PLAN.md §20.2/§46.7 — one shared, Ziyrak-owned webhook URL registered once
 * with Meta's App Dashboard for every business's phone number (§7.7's
 * `phone_number_id → ChannelConnection` resolution happens inside
 * `validateInbound`, not in this route).
 *
 * GET: Meta's one-time webhook subscription handshake
 * (https://developers.facebook.com/docs/graph-api/webhooks/getting-started)
 * — echoes `hub.challenge` back only if `hub.verify_token` matches this
 * deployment's own platform-level secret.
 */
export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get("hub.mode");
  const token = request.nextUrl.searchParams.get("hub.verify_token");
  const challenge = request.nextUrl.searchParams.get("hub.challenge");

  const verifyToken = getMetaWebhookVerifyToken();
  if (mode === "subscribe" && verifyToken && token === verifyToken && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }

  return new NextResponse("Forbidden", { status: 403 });
}

/**
 * PLAN.md §17.6/§20.2/§46.7 — verify (`X-Hub-Signature-256`, over the raw
 * body) → resolve (`phone_number_id`) → dedupe → persist → enqueue → ACK.
 * Reads the body as raw text first (never `request.json()`) since signature
 * verification requires the exact bytes Meta signed.
 */
export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const result = await metaCloudWhatsAppAdapter.validateInbound({ headers, rawBody });

    if (result.kind === "rejected") {
      logger.warn("[MetaWhatsApp] Inbound webhook rejected", { reason: result.reason });
      // An invalid signature is the one failure this route reports loudly
      // (§46.7's own "invalid signature rejected before persistence" test) —
      // every other rejection reason (no message, unknown phone_number_id,
      // a status callback) ACKs 200 exactly like every other channel's
      // "uninteresting update" case, so Meta never retries a payload that
      // was never going to succeed differently the second time.
      const status = result.reason === "Invalid X-Hub-Signature-256" ? 403 : 200;
      return NextResponse.json({ status: "ignored" }, { status });
    }

    if (result.kind === "new") {
      await enqueueInboundProcessing(result.ctx, result.receiptId, result.event);
    }

    return NextResponse.json({ status: "EVENT_RECEIVED" });
  } catch (error) {
    logger.error("[MetaWhatsApp] Webhook error:", error);
    return NextResponse.json({ status: "error" }, { status: 200 });
  }
}
