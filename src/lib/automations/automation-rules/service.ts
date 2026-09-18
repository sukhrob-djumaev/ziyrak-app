import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { NotFoundError } from "@/lib/observability/errors";
import { Prisma } from "@/generated/prisma/client";

/** PLAN.md §16.2 — application-service layer for the "automation" rules CRUD routes. */

export interface ListRulesParams {
  type?: string | null;
  skip: number;
  take: number;
}

export async function list(ctx: TenantContext, params: ListRulesParams) {
  const db = getScopedPrisma(ctx);
  const where: Record<string, unknown> = {};
  if (params.type && params.type !== "all") where.type = params.type;

  const [rules, total] = await Promise.all([
    db.automationRule.findMany({ where, orderBy: [{ priority: "desc" }, { createdAt: "desc" }], skip: params.skip, take: params.take }),
    db.automationRule.count({ where }),
  ]);
  return { rules, total };
}

export interface CreateRuleInput {
  name: string;
  description?: string;
  type: string;
  isActive?: boolean;
  conditions: unknown;
  actions: unknown;
  priority?: number;
}

export async function create(ctx: TenantContext, input: CreateRuleInput) {
  const db = getScopedPrisma(ctx);
  return db.automationRule.create({
    data: {
      businessId: ctx.businessId,
      name: input.name.trim(),
      description: input.description?.trim() || "",
      type: input.type,
      isActive: input.isActive ?? true,
      conditions: input.conditions as Prisma.InputJsonValue,
      actions: input.actions as Prisma.InputJsonValue,
      priority: input.priority ?? 0,
    },
  });
}

export interface UpdateRuleInput {
  name?: string;
  description?: string;
  type?: string;
  isActive?: boolean;
  conditions?: unknown;
  actions?: unknown;
  priority?: number;
}

export async function update(ctx: TenantContext, id: string, input: UpdateRuleInput) {
  const db = getScopedPrisma(ctx);
  const existing = await db.automationRule.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Automation rule");

  return db.automationRule.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.description !== undefined && { description: input.description.trim() }),
      ...(input.type !== undefined && { type: input.type }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(input.conditions !== undefined && { conditions: input.conditions as Prisma.InputJsonValue }),
      ...(input.actions !== undefined && { actions: input.actions as Prisma.InputJsonValue }),
      ...(input.priority !== undefined && { priority: input.priority }),
    },
  });
}

export async function remove(ctx: TenantContext, id: string): Promise<void> {
  const db = getScopedPrisma(ctx);
  const existing = await db.automationRule.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Automation rule");
  await db.automationRule.delete({ where: { id } });
}
