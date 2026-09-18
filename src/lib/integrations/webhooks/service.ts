import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { NotFoundError } from "@/lib/observability/errors";
import { Prisma } from "@/generated/prisma/client";

/** PLAN.md §16.2 — application-service layer for "webhooks" (+ deliveries). */

export interface ListWebhooksParams {
  skip: number;
  take: number;
}

export async function list(ctx: TenantContext, params: ListWebhooksParams) {
  const db = getScopedPrisma(ctx);
  const [webhooks, total] = await Promise.all([
    db.webhook.findMany({ orderBy: { createdAt: "desc" }, skip: params.skip, take: params.take }),
    db.webhook.count(),
  ]);
  return { webhooks, total };
}

export interface CreateWebhookInput {
  name: string;
  description?: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  triggerOn: string;
}

export async function create(ctx: TenantContext, input: CreateWebhookInput) {
  const db = getScopedPrisma(ctx);
  return db.webhook.create({
    data: {
      businessId: ctx.businessId,
      name: input.name,
      description: input.description || "",
      url: input.url,
      method: input.method || "POST",
      headers: (input.headers || {}) as Prisma.InputJsonValue,
      triggerOn: input.triggerOn,
    },
  });
}

export async function getById(ctx: TenantContext, id: string) {
  const db = getScopedPrisma(ctx);
  const webhook = await db.webhook.findUnique({ where: { id } });
  if (!webhook) throw new NotFoundError("Webhook");
  return webhook;
}

export interface UpdateWebhookInput {
  name?: string;
  description?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  triggerOn?: string;
  isActive?: boolean;
}

export async function update(ctx: TenantContext, id: string, input: UpdateWebhookInput) {
  const db = getScopedPrisma(ctx);
  const existing = await db.webhook.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Webhook");

  return db.webhook.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.url !== undefined && { url: input.url }),
      ...(input.method !== undefined && { method: input.method }),
      ...(input.headers !== undefined && { headers: input.headers as Prisma.InputJsonValue }),
      ...(input.triggerOn !== undefined && { triggerOn: input.triggerOn }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    },
  });
}

export async function remove(ctx: TenantContext, id: string): Promise<void> {
  const db = getScopedPrisma(ctx);
  const existing = await db.webhook.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Webhook");
  await db.webhook.delete({ where: { id } });
}

export interface ListDeliveriesParams {
  status?: string | null;
  skip: number;
  take: number;
}

export async function listDeliveries(ctx: TenantContext, webhookId: string, params: ListDeliveriesParams) {
  const db = getScopedPrisma(ctx);
  const webhook = await db.webhook.findUnique({ where: { id: webhookId } });
  if (!webhook) throw new NotFoundError("Webhook");

  const where: Record<string, unknown> = { webhookId };
  if (params.status && params.status !== "all") where.status = params.status;

  const [deliveries, total] = await Promise.all([
    db.webhookDelivery.findMany({ where, orderBy: { createdAt: "desc" }, skip: params.skip, take: params.take }),
    db.webhookDelivery.count({ where }),
  ]);

  return { deliveries, total };
}

export async function findDeliveryForWebhook(ctx: TenantContext, webhookId: string, deliveryId: string) {
  const db = getScopedPrisma(ctx);
  return db.webhookDelivery.findFirst({ where: { id: deliveryId, webhookId } });
}
