import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { NotFoundError } from "@/lib/errors";
import { Prisma } from "@/generated/prisma/client";

/** PLAN.md §16.2 — application-service layer for "flows". */

export interface ListFlowsParams {
  isActive?: string | null;
  skip: number;
  take: number;
}

export async function list(ctx: TenantContext, params: ListFlowsParams) {
  const db = getScopedPrisma(ctx);
  const where: Record<string, unknown> = {};
  if (params.isActive !== null && params.isActive !== undefined) where.isActive = params.isActive === "true";

  const [flows, total] = await Promise.all([
    db.flow.findMany({ where, orderBy: { createdAt: "desc" }, skip: params.skip, take: params.take }),
    db.flow.count({ where }),
  ]);
  return { flows, total };
}

export interface CreateFlowInput {
  name: string;
  description?: string;
  startNodeId?: string;
  nodes?: unknown;
  isActive?: boolean;
}

export async function create(ctx: TenantContext, input: CreateFlowInput) {
  const db = getScopedPrisma(ctx);
  return db.flow.create({
    data: {
      businessId: ctx.businessId,
      name: input.name.trim(),
      description: input.description?.trim() || "",
      startNodeId: input.startNodeId || "",
      nodes: (input.nodes ?? []) as Prisma.InputJsonValue,
      isActive: input.isActive ?? false,
    },
  });
}

export async function getById(ctx: TenantContext, id: string) {
  const db = getScopedPrisma(ctx);
  const flow = await db.flow.findUnique({ where: { id } });
  if (!flow) throw new NotFoundError("Flow");
  return flow;
}

export interface UpdateFlowInput {
  name?: string;
  description?: string;
  startNodeId?: string;
  nodes?: unknown;
  isActive?: boolean;
}

export async function update(ctx: TenantContext, id: string, input: UpdateFlowInput) {
  const db = getScopedPrisma(ctx);
  const existing = await db.flow.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Flow");

  return db.flow.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.description !== undefined && { description: input.description.trim() }),
      ...(input.startNodeId !== undefined && { startNodeId: input.startNodeId }),
      ...(input.nodes !== undefined && { nodes: input.nodes as Prisma.InputJsonValue }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    },
  });
}

export async function remove(ctx: TenantContext, id: string): Promise<void> {
  const db = getScopedPrisma(ctx);
  const existing = await db.flow.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Flow");
  await db.flow.delete({ where: { id } });
}
