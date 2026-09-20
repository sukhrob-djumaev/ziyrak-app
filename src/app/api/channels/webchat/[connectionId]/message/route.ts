import { NextRequest, NextResponse } from "next/server";
import { webChatAdapter } from "@/lib/channels/webchat-adapter";
import { normalizeJsonRequest } from "@/lib/channels/http-request";
import { enqueueInboundProcessing } from "@/lib/events/dispatch";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/observability/logger";

type RouteContext = { params: Promise<{ connectionId: string }> };

// §20.4 — deliberately tighter than the platform's general API rate limit
// (§30/§32): this is the one endpoint designed to accept requests from an
// unauthenticated, unknown party by definition. Per-token AND per-IP so
// neither a leaked token nor a shared IP alone can exhaust the limit for
// someone else. A per-connection `rateLimitPerMinute` override is left to
// Phase 8's Redis-backed limiter (§46.5's own deferral) — this in-memory
// default is what's available now.
const WEBCHAT_RATE_LIMIT = { maxRequests: 20, windowMs: 60_000 };

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * PLAN.md §17.6/§20.4/§46.5 — verify (token + Origin) → resolve → dedupe →
 * persist → enqueue → ACK, same shape as every other channel. Never runs
 * `chat()` inline; the widget learns the AI's reply by subscribing to the
 * `stream` route below using the same `conversationId` it already sent.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { connectionId } = await context.params;

    const ip = getClientIp(request);
    const rate = checkRateLimit(`webchat-msg:${connectionId}:${ip}`, WEBCHAT_RATE_LIMIT);
    if (!rate.allowed) {
      return NextResponse.json(
        { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many messages — please slow down." } },
        { status: 429 }
      );
    }

    const normalized = await normalizeJsonRequest(request, { connectionId });
    const result = await webChatAdapter.validateInbound(normalized);

    if (result.kind === "rejected") {
      logger.warn("[WebChat] Inbound message rejected", { connectionId, reason: result.reason });
      return NextResponse.json({ error: { code: "REJECTED", message: result.reason } }, { status: 403 });
    }

    if (result.kind === "new") {
      await enqueueInboundProcessing(result.ctx, result.receiptId, result.event);
    }

    return NextResponse.json({ status: result.kind });
  } catch (error) {
    logger.error("[WebChat] Failed to handle inbound message:", error);
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } }, { status: 500 });
  }
}
