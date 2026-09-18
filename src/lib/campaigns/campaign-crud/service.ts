import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { NotFoundError } from "@/lib/observability/errors";
import { Prisma } from "@/generated/prisma/client";

/** PLAN.md §16.2 — application-service layer for the "campaigns" CRUD routes. */

export interface ListCampaignsParams {
  status?: string | null;
  channel?: string | null;
  skip: number;
  take: number;
}

export async function list(ctx: TenantContext, params: ListCampaignsParams) {
  const db = getScopedPrisma(ctx);
  const where: Record<string, unknown> = {};
  if (params.status && params.status !== "all") where.status = params.status;
  if (params.channel && params.channel !== "all") where.channel = params.channel;

  const [campaigns, total] = await Promise.all([
    db.campaign.findMany({ where, orderBy: { createdAt: "desc" }, skip: params.skip, take: params.take }),
    db.campaign.count({ where }),
  ]);
  return { campaigns, total };
}

export interface CreateCampaignInput {
  name: string;
  description?: string;
  channel?: string;
  message: string;
  subject?: string;
  segments?: unknown;
  scheduledAt?: string;
}

export async function create(ctx: TenantContext, input: CreateCampaignInput) {
  const db = getScopedPrisma(ctx);
  return db.campaign.create({
    data: {
      businessId: ctx.businessId,
      name: input.name.trim(),
      description: input.description?.trim() || "",
      channel: input.channel || "email",
      message: input.message.trim(),
      subject: input.subject?.trim() || "",
      segments: (input.segments ?? []) as Prisma.InputJsonValue,
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
    },
  });
}

export async function getById(ctx: TenantContext, id: string) {
  const db = getScopedPrisma(ctx);
  const campaign = await db.campaign.findUnique({ where: { id } });
  if (!campaign) throw new NotFoundError("Campaign");
  return campaign;
}

export interface UpdateCampaignInput {
  name?: string;
  description?: string;
  channel?: string;
  message?: string;
  subject?: string;
  segments?: unknown;
  status?: string;
  scheduledAt?: string | null;
}

export async function update(ctx: TenantContext, id: string, input: UpdateCampaignInput) {
  const db = getScopedPrisma(ctx);
  const existing = await db.campaign.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Campaign");

  return db.campaign.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.description !== undefined && { description: input.description.trim() }),
      ...(input.channel !== undefined && { channel: input.channel }),
      ...(input.message !== undefined && { message: input.message.trim() }),
      ...(input.subject !== undefined && { subject: input.subject.trim() }),
      ...(input.segments !== undefined && { segments: input.segments as Prisma.InputJsonValue }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.scheduledAt !== undefined && {
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
      }),
    },
  });
}

export async function remove(ctx: TenantContext, id: string): Promise<void> {
  const db = getScopedPrisma(ctx);
  const existing = await db.campaign.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Campaign");
  await db.campaign.delete({ where: { id } });
}
