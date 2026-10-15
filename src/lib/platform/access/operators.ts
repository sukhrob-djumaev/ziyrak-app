import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { hashPassword } from "@/lib/identity/auth";
import { AppError, NotFoundError } from "@/lib/observability/errors";
import { withPlatformControl, readPlatformAuthority } from "./authority";
import { writePlatformAudit } from "./audit";
import { reserveNewUsername } from "../username-reservation";

// Support starts with explicitly named read operations. Execution, configuration,
// team, credentials and owner operations have no implied support permission.
export const SUPPORT_OPERATIONS = [
  "conversations:read",
  "messages:read",
  "tickets:read",
  "customers:read",
  "knowledge:read",
  "analytics:read",
  "activity:read",
] as const;
const id = z.string().min(1).max(128);
const reason = z.string().trim().min(1).max(1000);
const profile = z.enum(["none", "read", "write"]);
const scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), customerProfileAccess: profile }).strict(),
  z
    .object({
      kind: z.literal("connections"),
      connectionIds: z.array(id).min(1).max(200),
      customerProfileAccess: profile,
    })
    .strict(),
]);
const provision = z
  .object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(100)
      .regex(/^[a-zA-Z0-9_.-]+$/),
    password: z
      .string()
      .min(12)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 72),
    name: z.string().trim().min(1).max(200),
    reason,
  })
  .strict();
const assignment = z
  .object({
    operatorUserId: id,
    businessId: id,
    allowedOperations: z.array(z.enum(SUPPORT_OPERATIONS)).min(1).max(50),
    scope,
    reason,
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .strict();
const removal = z.object({ operatorUserId: id, reason }).strict();
const revocation = z.object({ assignmentId: id, reason }).strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid operator request");
  return result.data;
}
const safeAccount = { id: true, username: true, name: true, platformRole: true } as const;
const assignmentProjection = {
  id: true,
  operatorUserId: true,
  businessId: true,
  allowedOperations: true,
  scopeMode: true,
  customerProfileAccess: true,
  reason: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
  connectionScopes: { select: { connectionId: true } },
} as const;
async function activeOperator(tx: Prisma.TransactionClient, operatorUserId: string) {
  const user = await tx.user.findFirst({
    where: { id: operatorUserId, platformRole: "operator" },
    select: { id: true },
  });
  if (!user) throw new NotFoundError("Operator");
}

/** Creates a new identity only; never promotes or changes an existing account. */
export async function provisionOperator(token: string, input: unknown) {
  const request = parse(provision, input);
  const authority = await readPlatformAuthority(token);
  if (authority.role !== "super_admin")
    throw new AppError(403, "FORBIDDEN", "Super admin authority is required");
  // Expensive hashing stays outside the short serialization boundary. Authority
  // and session are resolved again after hashing, inside the write transaction.
  const password = await hashPassword(request.password);
  return withPlatformControl(token, "super_admin", async (tx, actor) => {
    await reserveNewUsername(tx, request.username);
    const user = await tx.user.create({
      data: { username: request.username, password, name: request.name, platformRole: "operator" },
      select: safeAccount,
    });
    await writePlatformAudit(tx, {
      actorUserId: actor.userId,
      action: "operator.provision",
      reason: request.reason,
      details: { targetUserId: user.id },
    });
    return user;
  });
}

/** Assignments are immutable ceilings; revoke and create a new record to replace. */
export async function assignOperator(token: string, input: unknown) {
  const request = parse(assignment, input);
  return withPlatformControl(token, "super_admin", async (tx, actor) => {
    const expiresAt = request.expiresAt ? new Date(request.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now())
      throw new AppError(400, "VALIDATION_ERROR", "Assignment expiry must be in the future");
    await activeOperator(tx, request.operatorUserId);
    if (
      !(await tx.business.findFirst({
        where: { id: request.businessId, status: "active" },
        select: { id: true },
      }))
    )
      throw new NotFoundError("Workspace");
    const connectionIds =
      request.scope.kind === "connections" ? [...new Set(request.scope.connectionIds)].sort() : [];
    // ChannelConnection is control-plane resident, including dedicated workspaces.
    // The composite FK additionally rejects a concurrent delete or foreign ID.
    if (
      connectionIds.length &&
      (await tx.channelConnection.count({
        where: { businessId: request.businessId, id: { in: connectionIds } },
      })) !== connectionIds.length
    )
      throw new NotFoundError("Connection");
    const allowedOperations = [...new Set(request.allowedOperations)].sort();
    const row = await tx.platformAssignment.create({
      data: {
        operatorUserId: request.operatorUserId,
        businessId: request.businessId,
        allowedOperations,
        scopeMode: request.scope.kind,
        customerProfileAccess: request.scope.customerProfileAccess,
        reason: request.reason,
        expiresAt,
      },
    });
    if (connectionIds.length)
      await tx.assignmentConnectionScope.createMany({
        data: connectionIds.map((connectionId) => ({
          businessId: row.businessId,
          operatorUserId: row.operatorUserId,
          assignmentId: row.id,
          connectionId,
        })),
      });
    await writePlatformAudit(tx, {
      actorUserId: actor.userId,
      businessId: row.businessId,
      action: "assignment.create",
      reason: request.reason,
      details: {
        assignmentId: row.id,
        operatorUserId: row.operatorUserId,
        allowedOperations,
        scope: {
          ...request.scope,
          ...(request.scope.kind === "connections" ? { connectionIds } : {}),
        },
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    });
    return tx.platformAssignment.findUniqueOrThrow({
      where: { id: row.id },
      select: assignmentProjection,
    });
  });
}

export async function revokeAssignment(token: string, input: unknown) {
  const request = parse(revocation, input);
  return withPlatformControl(token, "super_admin", async (tx, actor) => {
    const row = await tx.platformAssignment.findUnique({ where: { id: request.assignmentId } });
    if (!row) throw new NotFoundError("Assignment");
    const now = new Date();
    await tx.platformAssignment.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.supportGrant.updateMany({
      where: { assignmentId: row.id, revokedAt: null },
      data: { revokedAt: now },
    });
    await writePlatformAudit(tx, {
      actorUserId: actor.userId,
      businessId: row.businessId,
      action: "assignment.revoke",
      reason: request.reason,
      details: { assignmentId: row.id, operatorUserId: row.operatorUserId },
    });
    return tx.platformAssignment.findUniqueOrThrow({
      where: { id: row.id },
      select: assignmentProjection,
    });
  });
}

export async function removeOperator(token: string, input: unknown) {
  const request = parse(removal, input);
  return withPlatformControl(token, "super_admin", async (tx, actor) => {
    await activeOperator(tx, request.operatorUserId);
    const now = new Date();
    await tx.user.update({ where: { id: request.operatorUserId }, data: { platformRole: null } });
    await tx.platformAssignment.updateMany({
      where: { operatorUserId: request.operatorUserId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.supportGrant.updateMany({
      where: { actorUserId: request.operatorUserId, revokedAt: null },
      data: { revokedAt: now },
    });
    await writePlatformAudit(tx, {
      actorUserId: actor.userId,
      action: "operator.remove",
      reason: request.reason,
      details: { targetUserId: request.operatorUserId },
    });
    return { id: request.operatorUserId, platformRole: null };
  });
}

/** Management metadata only. No customer content, credentials or tenant context. */
export async function readOperatorConsole(token: string) {
  return withPlatformControl(token, "super_admin", async (tx) => {
    const operators = await tx.user.findMany({
      where: { platformRole: "operator" },
      select: safeAccount,
      orderBy: { id: "asc" },
      take: 201,
    });
    const workspaces = await tx.business.findMany({
      where: { status: "active" },
      select: {
        id: true,
        name: true,
        slug: true,
        channelConnections: {
          select: { id: true, name: true, type: true },
          orderBy: { id: "asc" },
          take: 201,
        },
      },
      orderBy: { id: "asc" },
      take: 201,
    });
    const assignments = await tx.platformAssignment.findMany({
      select: assignmentProjection,
      orderBy: { createdAt: "desc" },
      take: 201,
    });
    return {
      evaluatedAt: new Date().toISOString(),
      operators: operators.slice(0, 200),
      workspaces: workspaces
        .slice(0, 200)
        .map((w) => ({ ...w, channelConnections: w.channelConnections.slice(0, 200) })),
      assignments: assignments.slice(0, 200),
      allowedOperations: SUPPORT_OPERATIONS,
      truncated:
        operators.length > 200 ||
        workspaces.length > 200 ||
        assignments.length > 200 ||
        workspaces.some((w) => w.channelConnections.length > 200),
    };
  });
}
