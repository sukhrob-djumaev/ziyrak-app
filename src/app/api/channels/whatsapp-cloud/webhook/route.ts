import { NextRequest, NextResponse } from "next/server";
import { metaCloudWhatsAppAdapter } from "@/lib/channels/meta-whatsapp-adapter";
import { getMetaWebhookVerifyToken } from "@/lib/channels/meta-verify";
import { enqueueInboundProcessing } from "@/lib/events/dispatch";
import { logger } from "@/lib/observability/logger";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

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
/** Meta documents payloads of up to 3 MB; anything larger is rejected unread. */
const MAX_WEBHOOK_BODY_BYTES = 3 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const receivedAt = performance.now();
  const acknowledge = (
    outcome: "new" | "duplicate" | "ignored" | "error",
    status: number,
    context?: { businessId?: string; connectionId?: string }
  ) => {
    // This is handler completion time, measured from entry to constructing the
    // HTTP response. It deliberately excludes async AI/worker/reply work.
    logger.info("[MetaWhatsApp] Webhook acknowledged", {
      outcome,
      status,
      ackMs: Math.round((performance.now() - receivedAt) * 100) / 100,
      ...context,
    });
    return NextResponse.json(
      {
        status:
          outcome === "new" || outcome === "duplicate"
            ? "EVENT_RECEIVED"
            : outcome === "error"
              ? "error"
              : "ignored",
      },
      { status }
    );
  };

  try {
    // Preserve the exact wire bytes for Meta's HMAC. JSON parsing happens in
    // the adapter only to select a candidate connection; it never replaces
    // these bytes for signature verification.
    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!checkRateLimit(`meta-webhook:${clientIp}`, RATE_LIMITS.metaWebhook).allowed) {
      return NextResponse.json({ status: "rate_limited" }, { status: 429 });
    }
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BODY_BYTES) {
      return NextResponse.json({ status: "payload_too_large" }, { status: 413 });
    }
    const rawBody = Buffer.from(await request.arrayBuffer());
    if (rawBody.byteLength > MAX_WEBHOOK_BODY_BYTES) {
      return NextResponse.json({ status: "payload_too_large" }, { status: 413 });
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const result = await metaCloudWhatsAppAdapter.validateInbound({ headers, rawBody });

    if (result.kind === "rejected") {
      logger.warn("[MetaWhatsApp] Inbound webhook rejected", { reason: result.reason });
      // Only a callback whose signature was verified may be safely ignored
      // (for example, a status/non-text event). Every pre-verification
      // failure is fail-closed, including an unknown or ambiguous routing id.
      const status = result.authenticated === false ? 403 : 200;
      return acknowledge("ignored", status);
    }

    if (result.kind === "new") {
      await enqueueInboundProcessing(result.ctx, result.receiptId, result.event);
      return acknowledge("new", 200, { businessId: result.ctx.businessId, connectionId: result.connectionId });
    }

    return acknowledge("duplicate", 200);
  } catch (error) {
    logger.error("[MetaWhatsApp] Webhook error:", error);
    return acknowledge("error", 500);
  }
}
