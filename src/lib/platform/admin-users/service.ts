import { prisma } from "@/lib/prisma/raw-client";
import { hashPassword } from "@/lib/identity/auth";
import { ROLES } from "@/lib/rbac/rbac";
import { AppError, NotFoundError } from "@/lib/observability/errors";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

/**
 * PLAN.md §46.1/§46.2 — "admin users" now means "this business's own team
 * members" (a `Membership` row + the `User` it points at), not the legacy
 * global `Admin` table these routes used to manage directly. `Membership`
 * is tenant-owned (§16.4's own wording — "User outside of Membership" is
 * control-plane, Membership itself is not) and goes through
 * `getScopedPrisma(ctx)` like any other tenant resource; `User` itself is
 * control-plane (a person may belong to more than one business, §9.2) and
 * is only ever touched here for the create/credential-update half of this
 * feature — this file is in the ESLint raw-client allowlist for exactly
 * that reason, not to bypass tenant scoping on Membership.
 */

interface AdminUserView {
  id: string; // Membership id — this is the tenant-scoped identity for this feature
  userId: string;
  username: string;
  name: string;
  role: string;
  createdAt: Date;
}

function toView(membership: { id: string; role: string; createdAt: Date; user: { id: string; username: string; name: string } }): AdminUserView {
  return {
    id: membership.id,
    userId: membership.user.id,
    username: membership.user.username,
    name: membership.user.name,
    role: membership.role,
    createdAt: membership.createdAt,
  };
}

export interface ListParams {
  skip: number;
  take: number;
}

export async function list(ctx: TenantContext, params: ListParams) {
  const db = getScopedPrisma(ctx);
  const [memberships, total] = await Promise.all([
    db.membership.findMany({
      orderBy: { createdAt: "asc" },
      skip: params.skip,
      take: params.take,
      include: { user: { select: { id: true, username: true, name: true } } },
    }),
    db.membership.count(),
  ]);

  return { users: memberships.map(toView), total };
}

export interface CreateInput {
  username: string;
  password: string;
  name?: string;
  role?: string;
}

// A new team member can never be granted "owner" through this generic
// add-member flow — ownership transfer is its own explicit, deliberate
// action (§9.1), not a side effect of inviting someone.
const INVITABLE_ROLES = ROLES.filter((r) => r !== "owner");

export async function create(ctx: TenantContext, input: CreateInput) {
  const username = input.username.trim();
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) throw new AppError(409, "CONFLICT", "Username already exists");

  const role = INVITABLE_ROLES.includes(input.role as (typeof INVITABLE_ROLES)[number]) ? input.role! : "viewer";

  const hashed = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: { username, password: hashed, name: input.name?.trim() || username },
  });

  const db = getScopedPrisma(ctx);
  const membership = await db.membership.create({
    data: { businessId: ctx.businessId, userId: user.id, role },
  });

  return toView({ ...membership, user });
}

export interface UpdateInput {
  name?: string;
  role?: string;
  password?: string;
}

export async function update(ctx: TenantContext, membershipId: string, input: UpdateInput) {
  const db = getScopedPrisma(ctx);
  const membership = await db.membership.findUnique({ where: { id: membershipId }, include: { user: true } });
  if (!membership) throw new NotFoundError("User");

  if (input.role !== undefined && ROLES.includes(input.role as (typeof ROLES)[number])) {
    // Prevent removing the last owner (§9.1 — exactly one accountable
    // party per business is a structural requirement, not a preference).
    if (membership.role === "owner" && input.role !== "owner") {
      const ownerCount = await db.membership.count({ where: { role: "owner" } });
      if (ownerCount <= 1) {
        throw new AppError(400, "VALIDATION_ERROR", "Cannot change role of the last owner");
      }
    }
    await db.membership.update({ where: { id: membershipId }, data: { role: input.role } });
  }

  const userData: Record<string, unknown> = {};
  if (input.name !== undefined) userData.name = input.name.trim();
  if (input.password && input.password.length >= 6) userData.password = await hashPassword(input.password);
  if (Object.keys(userData).length > 0) {
    await prisma.user.update({ where: { id: membership.userId }, data: userData });
  }

  const updated = await db.membership.findUnique({ where: { id: membershipId }, include: { user: true } });
  return toView(updated!);
}

export async function remove(ctx: TenantContext, membershipId: string): Promise<void> {
  const db = getScopedPrisma(ctx);
  const membership = await db.membership.findUnique({ where: { id: membershipId } });
  if (!membership) throw new NotFoundError("User");

  if (membership.role === "owner") {
    const ownerCount = await db.membership.count({ where: { role: "owner" } });
    if (ownerCount <= 1) {
      throw new AppError(400, "VALIDATION_ERROR", "Cannot delete the last owner");
    }
  }

  // Deletes only this business's Membership — the underlying User is not
  // tenant-owned and may belong to other businesses (§16.4/§9.2).
  await db.membership.delete({ where: { id: membershipId } });
}
