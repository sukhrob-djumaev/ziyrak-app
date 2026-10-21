import crypto from "crypto";
import { Prisma } from "@/generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { captureDeferredIdentity } from "@/lib/tenancy/deferred-origin";
import { hasPermission } from "@/lib/rbac/rbac";
import { AppError } from "@/lib/observability/errors";
import { assertWorkspaceWideAuthority } from "@/lib/tenancy/workspace-authority";
import { jobQueue } from "@/lib/jobs/queue";
import { DELIVER_WEBHOOK_JOB, type DeliverWebhookPayload } from "@/lib/jobs/job-types";

interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * Generate HMAC-SHA256 signature for webhook payload verification.
 */
export function generateSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * PLAN.md §25.2/§46.6 PR2 task 11 — creates the `WebhookDelivery` record
 * and enqueues one durable `deliver-webhook` job for it. The actual HTTP
 * attempt (and every retry) happens in the job handler
 * (`jobs/handlers/deliver-webhook.ts`), not here — this function's own
 * job is done once the attempt is durably queued, replacing the old
 * `setTimeout`-recursive `attemptDelivery()` that ran (and retried)
 * entirely in this process's event loop, lost on restart.
 */
export async function deliverWebhook(
  ctx: TenantContext,
  webhook: WebhookConfig,
  event: string,
  data: Record<string, unknown>
): Promise<{ deliveryId: string; success: boolean }> {
  const db = getScopedPrisma(ctx);

  const delivery = await db.webhookDelivery.create({
    data: {
      businessId: ctx.businessId,
      webhookId: webhook.id,
      event,
      payload: {
        event,
        timestamp: new Date().toISOString(),
        webhookId: webhook.id,
        data,
      } as Prisma.InputJsonValue,
      status: "pending",
      attempts: 0,
    },
  });

  await jobQueue.enqueue<DeliverWebhookPayload>(DELIVER_WEBHOOK_JOB, {
    businessId: ctx.businessId,
    webhookId: webhook.id,
    deliveryId: delivery.id,
  });

  // "success" here means "durably queued for delivery," not "delivered" —
  // §24.1's own rule (never claim a status the infrastructure hasn't
  // backed yet) applies to this internal helper's return value exactly as
  // it does to a ToolResult. Callers that need the terminal delivery
  // status read WebhookDelivery.status once the job has run.
  return { deliveryId: delivery.id, success: true };
}

/**
 * Re-queues a specific failed delivery for another attempt.
 */
export async function retryDelivery(ctx: TenantContext, deliveryId: string): Promise<boolean> {
  if (
    !["user", "api_key"].includes(ctx.actor.kind) ||
    !ctx.role ||
    !hasPermission(ctx.role, "webhooks:update")
  )
    throw new AppError(
      403,
      "FORBIDDEN",
      "Retrying a delivery requires a signed-in authorized person"
    );
  assertWorkspaceWideAuthority(ctx, "Webhook delivery");
  const db = getScopedPrisma(ctx);
  const delivery = await db.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { webhook: true },
  });

  if (!delivery || !delivery.webhook) {
    return false;
  }

  // Save who is asking before changing anything, so a failure leaves the delivery as it was.
  const requestedBy = await captureDeferredIdentity(ctx);
  const previous = {
    status: delivery.status,
    attempts: delivery.attempts,
    lastError: delivery.lastError,
  };
  await db.webhookDelivery.update({
    where: { id: deliveryId },
    data: { status: "pending", attempts: 0, lastError: null },
  });
  try {
    await jobQueue.enqueue<DeliverWebhookPayload>(DELIVER_WEBHOOK_JOB, {
      businessId: ctx.businessId,
      webhookId: delivery.webhook.id,
      deliveryId: delivery.id,
      requestedBy,
    });
  } catch (error) {
    await db.webhookDelivery.update({ where: { id: deliveryId }, data: previous });
    throw error;
  }

  return true;
}
