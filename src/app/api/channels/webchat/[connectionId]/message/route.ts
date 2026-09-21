import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { webChatAdapter } from "@/lib/channels/webchat-adapter";
import { normalizeJsonRequest } from "@/lib/channels/http-request";
import { enqueueInboundProcessing } from "@/lib/events/dispatch";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/observability/logger";

type RouteContext = { params: Promise<{ connectionId: string }> };

// §20.4 — deliberately tighter than the platform's general API rate limit
// (§30/§32): this is the one endpoint designed to accept requests from an
// unauthenticated, unknown party by definition. Two independent buckets: a
// tight per-IP one (one visitor can't flood), and a looser per-token one (a
// leaked/abused token can't be used to flood a business from many IPs — the
// key uses a hash of the presented token, so a forged token just burns its
// own bucket). A per-connection `rateLimitPerMinute` override and
// cross-replica enforcement are Phase 8's Redis-backed limiter (§46.5's own
// deferral, re-confirmed by §46.7's prompt) — these in-memory, per-process
// defaults are what's available now.
const WEBCHAT_IP_RATE_LIMIT = { maxRequests: 20, windowMs: 60_000 };
const WEBCHAT_TOKEN_RATE_LIMIT = { maxRequests: 120, windowMs: 60_000 };

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * CORS preflight for the embedded widget (PLAN.md §20.4/§46.7): the widget's
 * `Content-Type: application/json` POST from a business's own site is a
 * non-simple cross-origin request. The preflight is answered only for an
 * origin on this connection's own allowlist; anything else gets a bare 204
 * with no `Access-Control-*` headers, which the browser treats as a refusal.
 */
export async function OPTIONS(request: NextRequest, context: RouteContext) {
  const { connectionId } = await context.params;
  const cors = await webChatAdapter.corsHeadersFor(connectionId, request.headers.get("origin") || "");
  if (!cors["Access-Control-Allow-Origin"]) return new NextResponse(null, { status: 204 });
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...cors,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
    },
  });
}

/**
 * PLAN.md §17.6/§20.4/§46.5 — verify (token + Origin) → resolve → dedupe →
 * persist → enqueue → ACK, same shape as every other channel. Never runs
 * `chat()` inline; the widget learns the AI's reply by subscribing to the
 * `stream` route below using the same `conversationId` it already sent.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { connectionId } = await context.params;
  const cors = await webChatAdapter.corsHeadersFor(connectionId, request.headers.get("origin") || "").catch(() => ({}));

  const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: cors });

  try {
    const ip = getClientIp(request);
    if (!checkRateLimit(`webchat-msg-ip:${connectionId}:${ip}`, WEBCHAT_IP_RATE_LIMIT).allowed) {
      return respond({ error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many messages — please slow down." } }, 429);
    }

    const normalized = await normalizeJsonRequest(request, { connectionId });

    const presentedToken = (normalized.json as { token?: unknown } | undefined)?.token;
    if (typeof presentedToken === "string" && presentedToken) {
      const tokenKey = crypto.createHash("sha256").update(presentedToken).digest("hex").slice(0, 32);
      if (!checkRateLimit(`webchat-msg-token:${connectionId}:${tokenKey}`, WEBCHAT_TOKEN_RATE_LIMIT).allowed) {
        return respond({ error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many messages — please slow down." } }, 429);
      }
    }

    const result = await webChatAdapter.validateInbound(normalized);

    if (result.kind === "rejected") {
      logger.warn("[WebChat] Inbound message rejected", { connectionId, reason: result.reason });
      return respond({ error: { code: "REJECTED", message: result.reason } }, 403);
    }

    if (result.kind === "new") {
      await enqueueInboundProcessing(result.ctx, result.receiptId, result.event);
    }

    return respond({ status: result.kind });
  } catch (error) {
    logger.error("[WebChat] Failed to handle inbound message:", error);
    return respond({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } }, 500);
  }
}
