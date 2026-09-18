import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { NotFoundError } from "@/lib/observability/errors";
import { Prisma } from "@/generated/prisma/client";

/**
 * PLAN.md §16.2 — application-service layer for the "customers" module.
 * Every function takes `ctx: TenantContext` explicit and calls
 * `getScopedPrisma(ctx)` internally; route handlers never touch Prisma
 * directly for this resource anymore.
 */

export interface ListCustomersParams {
  search?: string | null;
  isBlocked?: string | null;
  skip: number;
  take: number;
}

export async function list(ctx: TenantContext, params: ListCustomersParams) {
  const db = getScopedPrisma(ctx);
  const where: Record<string, unknown> = {};

  if (params.search && params.search.trim()) {
    const search = params.search.trim();
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
      { phone: { contains: search, mode: "insensitive" } },
    ];
  }

  if (params.isBlocked === "true") where.isBlocked = true;
  else if (params.isBlocked === "false") where.isBlocked = false;

  const [customers, total] = await Promise.all([
    db.customer.findMany({
      where,
      orderBy: { lastContact: "desc" },
      skip: params.skip,
      take: params.take,
      include: { _count: { select: { notes: true } } },
    }),
    db.customer.count({ where }),
  ]);

  return { customers, total };
}

export interface CreateCustomerInput {
  name: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  tags?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export async function create(ctx: TenantContext, input: CreateCustomerInput) {
  const db = getScopedPrisma(ctx);
  return db.customer.create({
    data: {
      // Explicit here (not left for the extension to inject, §8.3's
      // fallback) so the Prisma-generated input type is satisfied at
      // compile time; the extension still validates it matches ctx at
      // runtime regardless of how a caller constructed this payload.
      businessId: ctx.businessId,
      name: input.name.trim(),
      email: input.email?.trim() || "",
      phone: input.phone?.trim() || "",
      whatsapp: input.whatsapp?.trim() || "",
      tags: input.tags?.trim() || "",
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      ...(input.notes
        ? {
            // businessId is derived automatically from the parent Customer
            // via the composite FK (§8.4) — Prisma populates it from the
            // just-injected parent businessId, not accepted here directly.
            notes: { create: { content: input.notes.trim(), authorName: "Admin" } },
          }
        : {}),
    },
    include: { notes: true, _count: { select: { notes: true } } },
  });
}

export async function getById(ctx: TenantContext, id: string) {
  const db = getScopedPrisma(ctx);
  const customer = await db.customer.findUnique({
    where: { id },
    include: { notes: { orderBy: { createdAt: "desc" } } },
  });
  if (!customer) throw new NotFoundError("Customer");

  // Linked conversations by matching email, phone, or whatsapp.
  const contactFilters: Record<string, unknown>[] = [];
  if (customer.email) contactFilters.push({ customerContact: { equals: customer.email, mode: "insensitive" } });
  if (customer.phone) contactFilters.push({ customerContact: customer.phone });
  if (customer.whatsapp) contactFilters.push({ customerContact: customer.whatsapp });

  let conversations: unknown[] = [];
  if (contactFilters.length > 0) {
    conversations = await db.conversation.findMany({
      where: { OR: contactFilters },
      orderBy: { updatedAt: "desc" },
      include: {
        _count: { select: { messages: true } },
        tags: { include: { tag: true } },
      },
    });
  }

  return { ...customer, conversations };
}

export interface UpdateCustomerInput {
  name?: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  tags?: string;
  isBlocked?: boolean;
  metadata?: Record<string, unknown>;
}

export async function update(ctx: TenantContext, id: string, input: UpdateCustomerInput) {
  const db = getScopedPrisma(ctx);
  const existing = await db.customer.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Customer");

  return db.customer.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.email !== undefined && { email: input.email.trim() }),
      ...(input.phone !== undefined && { phone: input.phone.trim() }),
      ...(input.whatsapp !== undefined && { whatsapp: input.whatsapp.trim() }),
      ...(input.tags !== undefined && { tags: input.tags.trim() }),
      ...(input.isBlocked !== undefined && { isBlocked: input.isBlocked }),
      ...(input.metadata !== undefined && { metadata: input.metadata as Prisma.InputJsonValue }),
      lastContact: new Date(),
    },
    include: {
      notes: { orderBy: { createdAt: "desc" } },
      _count: { select: { notes: true } },
    },
  });
}

export async function remove(ctx: TenantContext, id: string): Promise<void> {
  const db = getScopedPrisma(ctx);
  const existing = await db.customer.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Customer");
  await db.customer.delete({ where: { id } });
}

export interface ListCustomerConversationsParams {
  channel?: string | null;
  skip: number;
  take: number;
}

export async function listConversations(
  ctx: TenantContext,
  customerId: string,
  params: ListCustomerConversationsParams
) {
  const db = getScopedPrisma(ctx);
  const customer = await db.customer.findUnique({
    where: { id: customerId },
    select: { id: true, email: true, phone: true, whatsapp: true },
  });
  if (!customer) throw new NotFoundError("Customer");

  const contactFilters: Record<string, unknown>[] = [{ customerId }];
  if (customer.email) contactFilters.push({ customerContact: { equals: customer.email, mode: "insensitive" } });
  if (customer.phone) contactFilters.push({ customerContact: customer.phone });
  if (customer.whatsapp) contactFilters.push({ customerContact: customer.whatsapp });

  const where: Record<string, unknown> = { OR: contactFilters };
  if (params.channel && params.channel !== "all") where.channel = params.channel;

  const [conversations, total] = await Promise.all([
    db.conversation.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: params.skip,
      take: params.take,
      include: {
        messages: { take: 1, orderBy: { createdAt: "desc" } },
        _count: { select: { messages: true } },
        tags: { include: { tag: true } },
      },
    }),
    db.conversation.count({ where }),
  ]);

  return { conversations, total };
}

export async function listNotes(ctx: TenantContext, customerId: string) {
  const db = getScopedPrisma(ctx);
  const customer = await db.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new NotFoundError("Customer");

  return db.customerNote.findMany({ where: { customerId }, orderBy: { createdAt: "desc" } });
}

export async function addNote(
  ctx: TenantContext,
  customerId: string,
  content: string,
  authorName?: string
) {
  const db = getScopedPrisma(ctx);
  const customer = await db.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new NotFoundError("Customer");

  return db.customerNote.create({
    data: {
      businessId: ctx.businessId,
      customerId,
      content: content.trim(),
      authorName: authorName?.trim() || "Admin",
    },
  });
}
