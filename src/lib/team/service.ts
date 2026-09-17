import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { assertSameTenant } from "@/lib/tenancy/assert-same-tenant";
import { NotFoundError } from "@/lib/errors";

/** PLAN.md §16.2 — application-service layer for "team" (departments + members). */

export interface ListDepartmentsParams {
  skip: number;
  take: number;
}

export async function listDepartments(ctx: TenantContext, params: ListDepartmentsParams) {
  const db = getScopedPrisma(ctx);
  const [departments, total] = await Promise.all([
    db.department.findMany({
      orderBy: { name: "asc" },
      skip: params.skip,
      take: params.take,
      include: { _count: { select: { members: true } } },
    }),
    db.department.count(),
  ]);
  return { departments, total };
}

export interface CreateDepartmentInput {
  name: string;
  description?: string;
  email?: string;
}

export async function createDepartment(ctx: TenantContext, input: CreateDepartmentInput) {
  const db = getScopedPrisma(ctx);
  return db.department.create({
    data: {
      businessId: ctx.businessId,
      name: input.name.trim(),
      description: input.description?.trim() || "",
      email: input.email?.trim() || "",
    },
    include: { _count: { select: { members: true } } },
  });
}

export interface UpdateDepartmentInput {
  name: string;
  description?: string;
  email?: string;
}

export async function updateDepartment(ctx: TenantContext, id: string, input: UpdateDepartmentInput) {
  const db = getScopedPrisma(ctx);
  const existing = await db.department.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Department");

  return db.department.update({
    where: { id },
    data: {
      name: input.name.trim(),
      description: input.description?.trim() || "",
      email: input.email?.trim() || "",
    },
    include: { _count: { select: { members: true } } },
  });
}

export async function removeDepartment(ctx: TenantContext, id: string): Promise<void> {
  const db = getScopedPrisma(ctx);
  const existing = await db.department.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Department");
  await db.department.delete({ where: { id } });
}

export interface ListMembersParams {
  departmentId?: string | null;
  skip: number;
  take: number;
}

export async function listMembers(ctx: TenantContext, params: ListMembersParams) {
  const db = getScopedPrisma(ctx);
  const where = params.departmentId ? { departmentId: params.departmentId } : {};

  const [members, total] = await Promise.all([
    db.teamMember.findMany({
      where,
      orderBy: { name: "asc" },
      skip: params.skip,
      take: params.take,
      include: { department: { select: { id: true, name: true } } },
    }),
    db.teamMember.count({ where }),
  ]);
  return { members, total };
}

export interface CreateMemberInput {
  name: string;
  email: string;
  phone?: string;
  role?: string;
  expertise?: string;
  departmentId: string;
}

export async function createMember(ctx: TenantContext, input: CreateMemberInput) {
  const db = getScopedPrisma(ctx);
  await assertSameTenant(db, "department", input.departmentId, "Department");

  return db.teamMember.create({
    data: {
      businessId: ctx.businessId,
      name: input.name.trim(),
      email: input.email.trim(),
      phone: input.phone?.trim() || "",
      role: input.role?.trim() || "member",
      expertise: input.expertise?.trim() || "",
      departmentId: input.departmentId,
    },
    include: { department: { select: { id: true, name: true } } },
  });
}

export interface UpdateMemberInput {
  name: string;
  email: string;
  phone?: string;
  role?: string;
  expertise?: string;
  departmentId: string;
  isAvailable?: boolean;
}

export async function updateMember(ctx: TenantContext, id: string, input: UpdateMemberInput) {
  const db = getScopedPrisma(ctx);
  const existing = await db.teamMember.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Team member");

  await assertSameTenant(db, "department", input.departmentId, "Department");

  return db.teamMember.update({
    where: { id },
    data: {
      name: input.name.trim(),
      email: input.email.trim(),
      phone: input.phone?.trim() || "",
      role: input.role?.trim() || "member",
      expertise: input.expertise?.trim() || "",
      departmentId: input.departmentId,
      ...(typeof input.isAvailable === "boolean" ? { isAvailable: input.isAvailable } : {}),
    },
    include: { department: { select: { id: true, name: true } } },
  });
}

export async function removeMember(ctx: TenantContext, id: string): Promise<void> {
  const db = getScopedPrisma(ctx);
  const existing = await db.teamMember.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Team member");
  await db.teamMember.delete({ where: { id } });
}
