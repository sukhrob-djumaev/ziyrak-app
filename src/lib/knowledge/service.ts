import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { assertSameTenant } from "@/lib/tenancy/assert-same-tenant";
import { NotFoundError } from "@/lib/errors";

/** PLAN.md §16.2 — application-service layer for "knowledge" (categories + entries). */

export interface ListCategoriesParams {
  skip: number;
  take: number;
}

export async function listCategories(ctx: TenantContext, params: ListCategoriesParams) {
  const db = getScopedPrisma(ctx);
  const [categories, total] = await Promise.all([
    db.category.findMany({
      orderBy: { sortOrder: "asc" },
      skip: params.skip,
      take: params.take,
      include: { _count: { select: { entries: true } } },
    }),
    db.category.count(),
  ]);
  return { categories, total };
}

export interface CreateCategoryInput {
  name: string;
  description?: string;
  icon?: string;
  color?: string;
}

export async function createCategory(ctx: TenantContext, input: CreateCategoryInput) {
  const db = getScopedPrisma(ctx);
  const maxSort = await db.category.aggregate({ _max: { sortOrder: true } });

  return db.category.create({
    data: {
      businessId: ctx.businessId,
      name: input.name.trim(),
      description: input.description?.trim() || "",
      icon: input.icon || "folder",
      color: input.color || "#4A7C9B",
      sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
    },
    include: { _count: { select: { entries: true } } },
  });
}

export interface UpdateCategoryInput {
  name?: string;
  description?: string;
  icon?: string;
  color?: string;
  sortOrder?: number;
}

export async function updateCategory(ctx: TenantContext, id: string, input: UpdateCategoryInput) {
  const db = getScopedPrisma(ctx);
  const existing = await db.category.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Category");

  return db.category.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.description !== undefined && { description: input.description.trim() }),
      ...(input.icon !== undefined && { icon: input.icon }),
      ...(input.color !== undefined && { color: input.color }),
      ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
    },
    include: { _count: { select: { entries: true } } },
  });
}

export async function removeCategory(ctx: TenantContext, id: string): Promise<void> {
  const db = getScopedPrisma(ctx);
  const existing = await db.category.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Category");
  await db.category.delete({ where: { id } });
}

export interface ListEntriesParams {
  categoryId?: string | null;
  skip: number;
  take: number;
}

export async function listEntries(ctx: TenantContext, params: ListEntriesParams) {
  const db = getScopedPrisma(ctx);
  const where = params.categoryId ? { categoryId: params.categoryId } : {};

  const [entries, total] = await Promise.all([
    db.knowledgeEntry.findMany({
      where,
      orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
      skip: params.skip,
      take: params.take,
      include: { category: { select: { id: true, name: true, color: true, icon: true } } },
    }),
    db.knowledgeEntry.count({ where }),
  ]);

  return { entries, total };
}

export interface CreateEntryInput {
  categoryId: string;
  title: string;
  content?: string;
  priority?: number;
}

export async function createEntry(ctx: TenantContext, input: CreateEntryInput) {
  const db = getScopedPrisma(ctx);
  await assertSameTenant(db, "category", input.categoryId, "Category");

  return db.knowledgeEntry.create({
    data: {
      businessId: ctx.businessId,
      categoryId: input.categoryId,
      title: input.title.trim(),
      content: input.content?.trim() || "",
      priority: typeof input.priority === "number" ? input.priority : 0,
    },
    include: { category: { select: { id: true, name: true, color: true, icon: true } } },
  });
}

export interface UpdateEntryInput {
  title?: string;
  content?: string;
  priority?: number;
  isActive?: boolean;
  categoryId?: string;
}

export async function updateEntry(ctx: TenantContext, id: string, input: UpdateEntryInput) {
  const db = getScopedPrisma(ctx);
  const existing = await db.knowledgeEntry.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Entry");

  if (input.categoryId !== undefined) await assertSameTenant(db, "category", input.categoryId, "Category");

  return db.knowledgeEntry.update({
    where: { id },
    data: {
      ...(input.title !== undefined && { title: input.title.trim() }),
      ...(input.content !== undefined && { content: input.content.trim() }),
      ...(input.priority !== undefined && { priority: input.priority }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
      version: { increment: 1 },
    },
    include: { category: { select: { id: true, name: true, color: true, icon: true } } },
  });
}

export async function removeEntry(ctx: TenantContext, id: string): Promise<void> {
  const db = getScopedPrisma(ctx);
  const existing = await db.knowledgeEntry.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Entry");
  await db.knowledgeEntry.delete({ where: { id } });
}

export async function listActiveEntriesForTest(ctx: TenantContext) {
  const db = getScopedPrisma(ctx);
  return db.knowledgeEntry.findMany({
    where: { isActive: true },
    include: { category: { select: { id: true, name: true, color: true } } },
    orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
  });
}
