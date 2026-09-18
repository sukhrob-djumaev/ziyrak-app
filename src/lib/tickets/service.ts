import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { assertSameTenant } from "@/lib/tenancy/assert-same-tenant";
import { NotFoundError } from "@/lib/observability/errors";

/**
 * PLAN.md §16.2/§8.5 — application-service layer for "tickets", the
 * worked example §8.4 itself uses for composite FKs. Every client-supplied
 * foreign-key id (conversationId, departmentId, assignedToId) is checked
 * with `assertSameTenant()` before the write, for a clean 404 instead of a
 * raw Postgres constraint-violation error — the composite FK (§8.4) is
 * still what actually enforces it either way (proven directly, bypassing
 * this service entirely, by tests/repository/composite-fk-bypass.test.ts).
 */

const TICKET_INCLUDE = {
  conversation: { select: { id: true, customerName: true, customerContact: true, channel: true, status: true } },
  department: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true, email: true } },
};

export interface ListTicketsParams {
  status?: string | null;
  priority?: string | null;
  departmentId?: string | null;
  search?: string | null;
  skip: number;
  take: number;
}

export async function list(ctx: TenantContext, params: ListTicketsParams) {
  const db = getScopedPrisma(ctx);
  const where: Record<string, unknown> = {};

  if (params.status && params.status !== "all") where.status = params.status;
  if (params.priority && params.priority !== "all") where.priority = params.priority;
  if (params.departmentId && params.departmentId !== "all") where.departmentId = params.departmentId;
  if (params.search && params.search.trim()) {
    const search = params.search.trim();
    where.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
    ];
  }

  const [tickets, total] = await Promise.all([
    db.ticket.findMany({ where, orderBy: { createdAt: "desc" }, skip: params.skip, take: params.take, include: TICKET_INCLUDE }),
    db.ticket.count({ where }),
  ]);

  return { tickets, total };
}

export interface CreateTicketInput {
  title: string;
  description?: string;
  priority?: string;
  status?: string;
  conversationId?: string;
  departmentId?: string;
  assignedToId?: string;
}

export async function create(ctx: TenantContext, input: CreateTicketInput) {
  const db = getScopedPrisma(ctx);

  if (input.conversationId) await assertSameTenant(db, "conversation", input.conversationId, "Conversation");
  if (input.departmentId) await assertSameTenant(db, "department", input.departmentId, "Department");
  if (input.assignedToId) await assertSameTenant(db, "teamMember", input.assignedToId, "Team member");

  return db.ticket.create({
    data: {
      businessId: ctx.businessId,
      title: input.title.trim(),
      description: input.description?.trim() || "",
      priority: input.priority || "medium",
      status: input.status || "open",
      ...(input.conversationId && { conversationId: input.conversationId }),
      ...(input.departmentId && { departmentId: input.departmentId }),
      ...(input.assignedToId && { assignedToId: input.assignedToId }),
    },
    include: TICKET_INCLUDE,
  });
}

export async function getById(ctx: TenantContext, id: string) {
  const db = getScopedPrisma(ctx);
  const ticket = await db.ticket.findUnique({ where: { id }, include: TICKET_INCLUDE });
  if (!ticket) throw new NotFoundError("Ticket");
  return ticket;
}

export interface UpdateTicketInput {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  resolution?: string;
  departmentId?: string | null;
  assignedToId?: string | null;
  conversationId?: string | null;
}

export async function update(ctx: TenantContext, id: string, input: UpdateTicketInput) {
  const db = getScopedPrisma(ctx);
  const existing = await db.ticket.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Ticket");

  if (input.conversationId) await assertSameTenant(db, "conversation", input.conversationId, "Conversation");
  if (input.departmentId) await assertSameTenant(db, "department", input.departmentId, "Department");
  if (input.assignedToId) await assertSameTenant(db, "teamMember", input.assignedToId, "Team member");

  return db.ticket.update({
    where: { id },
    data: {
      ...(input.title !== undefined && { title: input.title.trim() }),
      ...(input.description !== undefined && { description: input.description.trim() }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.priority !== undefined && { priority: input.priority }),
      ...(input.resolution !== undefined && { resolution: input.resolution.trim() }),
      ...(input.departmentId !== undefined && { departmentId: input.departmentId || null }),
      ...(input.assignedToId !== undefined && { assignedToId: input.assignedToId || null }),
      ...(input.conversationId !== undefined && { conversationId: input.conversationId || null }),
    },
    include: TICKET_INCLUDE,
  });
}

export async function remove(ctx: TenantContext, id: string): Promise<void> {
  const db = getScopedPrisma(ctx);
  const existing = await db.ticket.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Ticket");
  await db.ticket.delete({ where: { id } });
}
