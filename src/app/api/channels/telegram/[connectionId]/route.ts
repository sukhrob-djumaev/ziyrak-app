import { NextRequest, NextResponse } from "next/server";
import { telegramAdapter } from "@/lib/channels/telegram-adapter";
import { normalizeJsonRequest } from "@/lib/channels/http-request";
import { enqueueInboundProcessing } from "@/lib/events/dispatch";
import { logger } from "@/lib/observability/logger";

type RouteContext = { params: Promise<{ connectionId: string }> };

/**
 * PLAN.md §17.6/§19.2/§32/§46.5 — verify (secret-token header) → resolve
 * (`connectionId` from the path) → dedupe → persist → enqueue → ACK.
 * Telegram requires 200 OK even on a rejected/uninteresting update — a
 * non-2xx response makes Telegram retry indefinitely, which is never the
 * right behavior for "this update wasn't a text message" or "the secret
 * token didn't match" (a persistent attacker can't be made to stop
 * retrying by a webhook's status code either way, so there is no security
 * benefit to a 4xx here, only a reliability cost).
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { connectionId } = await context.params;
    const normalized = await normalizeJsonRequest(request, { connectionId });
    const result = await telegramAdapter.validateInbound(normalized);

    if (result.kind === "rejected") {
      logger.warn("[Telegram] Inbound update rejected", { connectionId, reason: result.reason });
      return NextResponse.json({ ok: true });
    }

    if (result.kind === "new") {
      await enqueueInboundProcessing(result.ctx, result.receiptId, result.event);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error("[Telegram] Webhook error:", error);
    return NextResponse.json({ ok: true });
  }
}
