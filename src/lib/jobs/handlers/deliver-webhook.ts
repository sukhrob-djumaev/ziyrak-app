import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { dispatchHttpRequest } from "@/lib/integrations/http-dispatcher";
import { generateSignature } from "@/lib/integrations/webhook-delivery";
import { logger } from "@/lib/observability/logger";
import { jobQueue } from "@/lib/jobs/queue";
import { DELIVER_WEBHOOK_JOB, type DeliverWebhookPayload } from "@/lib/jobs/job-types";
import { DELIVER_WEBHOOK_MAX_ATTEMPTS } from "@/lib/jobs/queue-config";

/**
 * PLAN.md §25.2/§31.1/§32.1/§46.6 PR2 task 11 — replaces
 * `webhook-delivery.ts`'s `setTimeout`-based `attemptDelivery` recursion
 * (retry state lived only in the process's event loop, lost on restart)
 * with a durable pg-boss job: each invocation of this handler is exactly
 * one delivery attempt, and a thrown error lets pg-boss's own native
 * retry/backoff (configured per-queue, `jobs/queue-config.ts`) schedule
 * the next attempt — durable across a worker restart, unlike the old
 * timer. Routed through the shared SSRF-hardened dispatcher (§32.1),
 * closing the same gap `trigger_webhook` closed in PR1.
 *
 * Idempotent under retry (§31.2/§33.4 item 6): a delivery already marked
 * `delivered` is a no-op, so a job retried after its own side effect
 * already landed (e.g. the HTTP call succeeded but this process crashed
 * before recording it) never delivers twice.
 */
export async function handleDeliverWebhook(ctx: TenantContext, payload: DeliverWebhookPayload): Promise<void> {
  const db = getScopedPrisma(ctx);

  const webhook = await db.webhook.findUnique({ where: { id: payload.webhookId } });
  if (!webhook) {
    logger.warn("[deliver-webhook] webhook no longer exists, skipping", { businessId: ctx.businessId, webhookId: payload.webhookId });
    return;
  }

  const delivery = await db.webhookDelivery.findUnique({ where: { id: payload.deliveryId } });
  if (!delivery) {
    logger.warn("[deliver-webhook] delivery record no longer exists, skipping", { businessId: ctx.businessId, deliveryId: payload.deliveryId });
    return;
  }

  if (delivery.status === "delivered") {
    return; // already succeeded on a previous attempt this exact job retried past
  }

  const attempt = delivery.attempts + 1;
  const webhookSecret = process.env.WEBHOOK_SECRET || "";
  const payloadString = JSON.stringify(delivery.payload);
  const signature = webhookSecret ? generateSignature(payloadString, webhookSecret) : "";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Owly-Webhook/1.0",
    ...(webhook.headers as Record<string, string>),
    ...(signature ? { "X-Owly-Signature": signature } : {}),
  };

  try {
    const response = await dispatchHttpRequest(webhook.url, {
      method: webhook.method,
      headers,
      body: webhook.method !== "GET" ? payloadString : undefined,
      timeoutMs: 10000,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    await db.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: "delivered", statusCode: response.status, attempts: attempt, lastError: null },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = attempt >= DELIVER_WEBHOOK_MAX_ATTEMPTS;

    await db.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: exhausted ? "failed" : "pending",
        attempts: attempt,
        lastError: message,
        statusCode: null,
      },
    });

    logger.warn(`[deliver-webhook] attempt ${attempt}/${DELIVER_WEBHOOK_MAX_ATTEMPTS} failed`, {
      businessId: ctx.businessId,
      deliveryId: delivery.id,
      webhookId: webhook.id,
      error: message,
    });

    throw error; // lets pg-boss's own retry policy schedule the next attempt
  }
}

jobQueue.registerHandler<DeliverWebhookPayload>(DELIVER_WEBHOOK_JOB, handleDeliverWebhook);
