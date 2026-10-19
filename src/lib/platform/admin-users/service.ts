import { prisma } from "@/lib/prisma/raw-client";
import { hashPassword } from "@/lib/identity/auth";
import { ROLES, hasPermission } from "@/lib/rbac/rbac";
import { AppError, NotFoundError } from "@/lib/observability/errors";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { effectiveResourceScope } from "@/lib/tenancy/resource-query";
import { lockTenantWrites } from "@/lib/tenancy/work-lifecycle";
import { reserveNewUsername } from "../username-reservation";

function assertWorkspaceDelegation(
  ctx: TenantContext,
  permission: "admin:create" | "admin:update" | "admin:delete"
) {
  if (
    ctx.actor.kind !== "user" ||
    !hasPermission(ctx.role ?? "", permission) ||
    effectiveResourceScope(ctx).kind !== "workspace"
  )
    throw new AppError(
      403,
      "FORBIDDEN",
      "Team access management requires workspace-wide human authority"
    );
}

/**
 * PLAN.md §46.1/§46.2 — "admin users" now means "this business's own team
 * members" (a `Membership` row + the `User` it points at), not the legacy
 * global `Admin` table these routes used to manage directly. `Membership`
 * is tenant-owned (§16.4's own wording — "User outside of Membership" is
 * control-plane, Membership itself is not) and goes through
 * `getScopedPrisma(ctx)` like any other tenant resource; `User` itself is
 * control-plane (a person may belong to more than one business, §9.2) and
 * is only ever touched here for the secured create half of this
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
  /** Null when the viewer is itself connection-restricted and may not see others' reach. */
  scope: MemberScopeView | null;
}

export type MemberScopeView =
  | { kind: "workspace" | "unclassified"; customerProfileAccess: string }
  | { kind: "connections"; customerProfileAccess: string; connectionIds: string[] };

function toView(
  membership: {
    id: string;
    role: string;
    createdAt: Date;
    scopeMode?: string;
    customerProfileAccess?: string;
    user: { id: string; username: string; name: string };
  },
  connectionIds?: string[]
): AdminUserView {
  return {
    id: membership.id,
    userId: membership.user.id,
    username: membership.user.username,
    name: membership.user.name,
    role: membership.role,
    createdAt: membership.createdAt,
    scope:
      membership.scopeMode === undefined || !connectionIds
        ? null
        : membership.scopeMode === "connections"
          ? {
              kind: "connections",
              customerProfileAccess: membership.customerProfileAccess ?? "none",
              connectionIds,
            }
          : {
              kind: membership.scopeMode as "workspace" | "unclassified",
              customerProfileAccess: membership.customerProfileAccess ?? "none",
            },
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

  // Scope rows are control-plane resident; only a workspace-wide viewer sees other members' reach.
  const mayViewScope = effectiveResourceScope(ctx).kind === "workspace";
  const scopes = mayViewScope
    ? await prisma.membershipConnectionScope.findMany({
        where: { businessId: ctx.businessId, membershipId: { in: memberships.map((m) => m.id) } },
        select: { membershipId: true, connectionId: true },
      })
    : [];
  return {
    users: memberships.map((m) =>
      toView(
        m,
        mayViewScope
          ? scopes.filter((row) => row.membershipId === m.id).map((row) => row.connectionId)
          : undefined
      )
    ),
    total,
  };
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
  assertWorkspaceDelegation(ctx, "admin:create");
  const username = input.username.trim();
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) throw new AppError(409, "CONFLICT", "Username already exists");

  const role = INVITABLE_ROLES.includes(input.role as (typeof INVITABLE_ROLES)[number])
    ? input.role!
    : "viewer";

  const hashed = await hashPassword(input.password);
  const user = await prisma.$transaction(async (tx) => {
    await reserveNewUsername(tx, username);
    return tx.user.create({
      data: { username, password: hashed, name: input.name?.trim() || username },
    });
  });

  const db = getScopedPrisma(ctx);
  const membership = await db.membership.create({
    data: {
      businessId: ctx.businessId,
      userId: user.id,
      role,
      scopeMode: "workspace",
      customerProfileAccess: effectiveResourceScope(ctx).customerProfileAccess,
    },
  });

  return toView({ ...membership, user });
}

export interface UpdateInput {
  name?: string;
  role?: string;
  password?: string;
  scope?: unknown;
}

type RequestedScope =
  | { kind: "workspace"; customerProfileAccess: "none" | "read" | "write" }
  | {
      kind: "connections";
      connectionIds: string[];
      customerProfileAccess: "none" | "read" | "write";
    };

// Exactly the shapes the editor can express; anything else (including "unclassified", unknown
// keys and a connection list on a workspace scope) is a validation error before any write.
function parseRequestedScope(input: unknown): RequestedScope {
  const invalid = () => new AppError(400, "VALIDATION_ERROR", "Invalid access scope");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const raw = input as Record<string, unknown>;
  const profile = raw.customerProfileAccess ?? "none";
  if (profile !== "none" && profile !== "read" && profile !== "write") throw invalid();
  const allowed =
    raw.kind === "workspace"
      ? ["kind", "customerProfileAccess"]
      : ["kind", "customerProfileAccess", "connectionIds"];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw invalid();
  if (raw.kind === "workspace") return { kind: "workspace", customerProfileAccess: profile };
  if (
    raw.kind !== "connections" ||
    !Array.isArray(raw.connectionIds) ||
    raw.connectionIds.length < 1 ||
    raw.connectionIds.length > 100 ||
    raw.connectionIds.some((id) => typeof id !== "string" || !id || id.length > 128)
  )
    throw invalid();
  return {
    kind: "connections",
    connectionIds: [...new Set(raw.connectionIds as string[])],
    customerProfileAccess: profile,
  };
}

export async function update(ctx: TenantContext, membershipId: string, input: UpdateInput) {
  assertWorkspaceDelegation(ctx, "admin:update");
  const db = getScopedPrisma(ctx);
  const membership = await db.membership.findUnique({
    where: { id: membershipId },
    include: { user: true },
  });
  if (!membership) throw new NotFoundError("User");

  if (ctx.actor.kind !== "user" || !hasPermission(ctx.role ?? "", "admin:update")) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Team role management requires an authorized workspace member"
    );
  }
  // User is a shared identity, not a workspace resource. Credential/profile
  // changes belong to authenticated account flows (P3), never team editing.
  // Validate the entire request before any membership write.
  if (input.name !== undefined || input.password !== undefined) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Account identity cannot be changed through workspace team management"
    );
  }
  const actorUserId = ctx.actor.kind === "user" ? ctx.actor.userId : null;
  const requestedScope = input.scope === undefined ? undefined : parseRequestedScope(input.scope);
  if (input.role !== undefined) {
    if (!ROLES.includes(input.role as (typeof ROLES)[number])) {
      throw new AppError(400, "VALIDATION_ERROR", "Unknown workspace role");
    }
    if (input.role === "owner" || membership.role === "owner") {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Ownership changes require the explicit ownership transfer flow"
      );
    }
  }
  // Membership and its scope rows are control-plane resident. One raw transaction under the
  // workspace write fence (the same fence sending admission takes) re-reads the target, so role
  // and scope change together or not at all and cannot race an admission or another editor.
  await prisma.$transaction(async (tx) => {
    await lockTenantWrites(tx, ctx.businessId);
    // The acting admin's own authority is judged here, under the fence, not from request start.
    const actorNow = actorUserId
      ? await tx.membership.findFirst({
          where: { businessId: ctx.businessId, userId: actorUserId },
        })
      : null;
    if (
      !actorNow ||
      !hasPermission(actorNow.role, "admin:update") ||
      actorNow.scopeMode !== "workspace"
    )
      throw new AppError(
        403,
        "FORBIDDEN",
        "Team access management requires workspace-wide human authority"
      );
    const rank = { none: 0, read: 1, write: 2 } as const;
    if (
      requestedScope &&
      rank[requestedScope.customerProfileAccess] >
        rank[actorNow.customerProfileAccess as keyof typeof rank]
    )
      throw new AppError(
        403,
        "FORBIDDEN",
        "Cannot grant more customer-profile access than you hold"
      );
    const fresh = await tx.membership.findFirst({
      where: { id: membershipId, businessId: ctx.businessId },
    });
    if (!fresh) throw new NotFoundError("User");
    if (fresh.role === "owner")
      throw new AppError(
        403,
        "FORBIDDEN",
        "Ownership changes require the explicit ownership transfer flow"
      );
    if (requestedScope) {
      if (fresh.userId === actorUserId)
        throw new AppError(
          403,
          "FORBIDDEN",
          "This membership's access scope cannot be edited here"
        );
      if (requestedScope.kind === "connections") {
        const known = await tx.channelConnection.count({
          where: { businessId: ctx.businessId, id: { in: requestedScope.connectionIds } },
        });
        if (known !== requestedScope.connectionIds.length)
          throw new AppError(400, "VALIDATION_ERROR", "Unknown connection for this workspace");
      }
      await tx.membership.update({
        where: { id: membershipId },
        data: {
          scopeMode: requestedScope.kind,
          customerProfileAccess: requestedScope.customerProfileAccess,
        },
      });
      await tx.membershipConnectionScope.deleteMany({
        where: { businessId: ctx.businessId, membershipId },
      });
      if (requestedScope.kind === "connections")
        await tx.membershipConnectionScope.createMany({
          data: requestedScope.connectionIds.map((connectionId) => ({
            businessId: ctx.businessId,
            membershipId,
            connectionId,
          })),
        });
    }
    if (input.role !== undefined)
      await tx.membership.update({ where: { id: membershipId }, data: { role: input.role } });
  });

  const updated = await db.membership.findUnique({
    where: { id: membershipId },
    include: { user: true },
  });
  return toView(updated!);
}

export async function remove(ctx: TenantContext, membershipId: string): Promise<void> {
  assertWorkspaceDelegation(ctx, "admin:delete");
  const db = getScopedPrisma(ctx);
  const membership = await db.membership.findUnique({ where: { id: membershipId } });
  if (!membership) throw new NotFoundError("User");

  if (ctx.actor.kind !== "user" || !hasPermission(ctx.role ?? "", "admin:delete")) {
    throw new AppError(403, "FORBIDDEN", "Team removal requires an authorized workspace member");
  }
  if (membership.role === "owner") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Ownership changes require the explicit ownership transfer flow"
    );
  }

  // Deletes only this business's Membership — the underlying User is not
  // tenant-owned and may belong to other businesses (§16.4/§9.2).
  await db.membership
    .delete({ where: { id: membershipId, role: { not: "owner" } } })
    .catch((error: unknown) => {
      if ((error as { code?: string } | null)?.code === "P2025") throw new NotFoundError("User");
      throw error;
    });
}
