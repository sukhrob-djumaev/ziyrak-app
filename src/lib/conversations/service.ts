import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { NotFoundError } from "@/lib/observability/errors";

/**
 * PLAN.md §16.2 — application-service layer for the "conversations" module.
 */

const LIST_INCLUDE = {
  messages: { take: 1, orderBy: { createdAt: "desc" as const } },
  _count: { select: { messages: true } },
  tags: { include: { tag: true } },
};

export interface ListConversationsParams {
  channel?: string | null;
  status?: string | null;
  search?: string | null;
  skip: number;
  take: number;
}

export async function list(ctx: TenantContext, params: ListConversationsParams) {
  const db = getScopedPrisma(ctx);
  const where: Record<string, unknown> = {};

  if (params.channel && params.channel !== "all") where.channel = params.channel;
  if (params.status && params.status !== "all") where.status = params.status;
  if (params.search && params.search.trim()) {
    const search = params.search.trim();
    where.OR = [
      { customerName: { contains: search, mode: "insensitive" } },
      { customerContact: { contains: search, mode: "insensitive" } },
    ];
  }

  const [conversations, total] = await Promise.all([
    db.conversation.findMany({ where, orderBy: { updatedAt: "desc" }, skip: params.skip, take: params.take, include: LIST_INCLUDE }),
    db.conversation.count({ where }),
  ]);

  return { conversations, total };
}

export interface CreateConversationInput {
  channel: string;
  customerName?: string;
  customerContact?: string;
  status?: string;
}

export async function create(ctx: TenantContext, input: CreateConversationInput) {
  const db = getScopedPrisma(ctx);
  return db.conversation.create({
    data: {
      businessId: ctx.businessId,
      channel: input.channel.trim(),
      customerName: input.customerName?.trim() || "Unknown",
      customerContact: input.customerContact?.trim() || "",
      status: input.status || "active",
    },
    include: LIST_INCLUDE,
  });
}

export async function getById(ctx: TenantContext, id: string) {
  const db = getScopedPrisma(ctx);
  const conversation = await db.conversation.findUnique({
    where: { id },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      customer: true,
      tags: { include: { tag: true } },
      tickets: { include: { department: true, assignedTo: true } },
      _count: { select: { messages: true } },
    },
  });
  if (!conversation) throw new NotFoundError("Conversation");
  return conversation;
}

export interface UpdateConversationInput {
  status?: string;
  customerName?: string;
  customerContact?: string;
  summary?: string;
  satisfaction?: number;
  tagIds?: string[];
}

export async function update(ctx: TenantContext, id: string, input: UpdateConversationInput) {
  const db = getScopedPrisma(ctx);
  const existing = await db.conversation.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Conversation");

  await db.conversation.update({
    where: { id },
    data: {
      ...(input.status !== undefined && { status: input.status }),
      ...(input.customerName !== undefined && { customerName: input.customerName.trim() }),
      ...(input.customerContact !== undefined && { customerContact: input.customerContact.trim() }),
      ...(input.summary !== undefined && { summary: input.summary.trim() }),
      ...(input.satisfaction !== undefined && { satisfaction: input.satisfaction }),
    },
  });

  if (input.tagIds && Array.isArray(input.tagIds)) {
    await db.conversationTag.deleteMany({ where: { conversationId: id } });
    if (input.tagIds.length > 0) {
      await db.conversationTag.createMany({
        data: input.tagIds.map((tagId) => ({ businessId: ctx.businessId, conversationId: id, tagId })),
      });
    }
  }

  return db.conversation.findUnique({
    where: { id },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      tags: { include: { tag: true } },
      _count: { select: { messages: true } },
    },
  });
}

export async function remove(ctx: TenantContext, id: string): Promise<void> {
  const db = getScopedPrisma(ctx);
  const existing = await db.conversation.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Conversation");
  await db.conversation.delete({ where: { id } });
}

export async function listMessages(ctx: TenantContext, conversationId: string) {
  const db = getScopedPrisma(ctx);
  const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) throw new NotFoundError("Conversation");

  return db.message.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } });
}

export async function addMessage(
  ctx: TenantContext,
  conversationId: string,
  content: string,
  role?: string
) {
  const db = getScopedPrisma(ctx);
  const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) throw new NotFoundError("Conversation");

  const validRoles = ["customer", "assistant", "system"];
  const messageRole = role && validRoles.includes(role) ? role : "assistant";

  const message = await db.message.create({
    data: { businessId: ctx.businessId, conversationId, role: messageRole, content: content.trim() },
  });

  await db.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });

  return message;
}

export async function listNotes(ctx: TenantContext, conversationId: string) {
  const db = getScopedPrisma(ctx);
  const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) throw new NotFoundError("Conversation");

  return db.internalNote.findMany({ where: { conversationId }, orderBy: { createdAt: "desc" } });
}

export async function addNote(
  ctx: TenantContext,
  conversationId: string,
  content: string,
  authorName?: string
) {
  const db = getScopedPrisma(ctx);
  const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) throw new NotFoundError("Conversation");

  return db.internalNote.create({
    data: {
      businessId: ctx.businessId,
      conversationId,
      content: content.trim(),
      authorName: authorName?.trim() || "Admin",
    },
  });
}

export async function setSatisfaction(ctx: TenantContext, conversationId: string, rating: number) {
  const db = getScopedPrisma(ctx);
  const existing = await db.conversation.findUnique({ where: { id: conversationId } });
  if (!existing) throw new NotFoundError("Conversation");

  return db.conversation.update({ where: { id: conversationId }, data: { satisfaction: rating } });
}
