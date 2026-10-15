import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { AppError, NotFoundError } from "@/lib/observability/errors";
import {
  scopeFromRecord,
  scopeIsWithin,
  intersectResourceScopes,
  type ResourceScope,
} from "@/lib/tenancy/resource-scope";
import { withPlatformControl, type PlatformAuthority } from "./authority";
import { writePlatformAudit } from "./audit";
import { SUPPORT_OPERATIONS } from "./operators";

// This lifecycle service is intentionally not wired into tenant authentication.
// Issuing a record never creates membership, tenant context or usable job authority.
const id = z.string().min(1).max(128);
const reason = z.string().trim().min(1).max(1000);
const profile = z.enum(["none", "read", "write"]);
const issue = z
  .object({
    businessId: id,
    assignmentId: id.optional(),
    requestId: z.uuid().transform((value) => value.toLowerCase()),
    allowedOperations: z.array(z.enum(SUPPORT_OPERATIONS)).min(1).max(50),
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("workspace"), customerProfileAccess: profile }).strict(),
      z
        .object({
          kind: z.literal("connections"),
          customerProfileAccess: profile,
          connectionIds: z.array(id).min(1).max(200),
        })
        .strict(),
    ]),
    reason,
    expiresAt: z.iso.datetime(),
  })
  .strict();
const revoke = z.object({ grantId: id, reason }).strict();
export const MAX_SUPPORT_GRANT_MS = 24 * 60 * 60_000;
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid support request");
  return result.data;
}
const projection = {
  id: true,
  actorUserId: true,
  businessId: true,
  assignmentId: true,
  requestId: true,
  allowedOperations: true,
  scopeMode: true,
  customerProfileAccess: true,
  reason: true,
  expiresAt: true,
  revokedAt: true,
  connectionScopes: { select: { connectionId: true }, orderBy: { connectionId: "asc" as const } },
} as const;
type Request = z.infer<typeof issue>;
type Grant = Prisma.SupportGrantGetPayload<{ select: typeof projection }>;
function normalized(request: Request) {
  const scope: ResourceScope =
    request.scope.kind === "connections"
      ? {
          kind: "connections",
          customerProfileAccess: request.scope.customerProfileAccess,
          connectionIds: [...new Set(request.scope.connectionIds)].sort(),
        }
      : { kind: "workspace", customerProfileAccess: request.scope.customerProfileAccess };
  return {
    businessId: request.businessId,
    assignmentId: request.assignmentId ?? null,
    allowedOperations: [...new Set(request.allowedOperations)].sort(),
    scope,
    reason: request.reason,
    expiresAt: new Date(request.expiresAt).toISOString(),
  };
}

function sameRequest(grant: Grant, request: ReturnType<typeof normalized>) {
  return (
    JSON.stringify(
      normalized({
        businessId: grant.businessId,
        assignmentId: grant.assignmentId ?? undefined,
        requestId: grant.requestId,
        allowedOperations: grant.allowedOperations as Request["allowedOperations"],
        scope: scopeFromRecord(grant),
        reason: grant.reason,
        expiresAt: grant.expiresAt.toISOString(),
      })
    ) === JSON.stringify(request)
  );
}
async function currentCeiling(
  tx: Prisma.TransactionClient,
  actor: PlatformAuthority,
  request: ReturnType<typeof normalized>
) {
  if (actor.role === "super_admin") {
    if (request.assignmentId)
      throw new AppError(403, "FORBIDDEN", "Super admin support requires its own explicit grant");
    return;
  }
  if (!request.assignmentId)
    throw new AppError(403, "FORBIDDEN", "A current named assignment is required");
  const assignment = await tx.platformAssignment.findFirst({
    where: {
      id: request.assignmentId,
      businessId: request.businessId,
      operatorUserId: actor.userId,
      revokedAt: null,
    },
    include: { connectionScopes: true },
  });
  if (
    !assignment ||
    (assignment.expiresAt && assignment.expiresAt.getTime() <= Date.now()) ||
    (assignment.expiresAt && Date.parse(request.expiresAt) > assignment.expiresAt.getTime()) ||
    request.allowedOperations.some((op) => !assignment.allowedOperations.includes(op)) ||
    !scopeIsWithin(request.scope, scopeFromRecord(assignment))
  )
    throw new AppError(403, "FORBIDDEN", "Support request exceeds the current assignment");
}

/** Explicit actor-self issuance with immutable UUID replay; not an access resolver. */
export async function issueSupportGrant(token: string, input: unknown) {
  const parsed = parse(issue, input),
    request = normalized(parsed);
  return withPlatformControl(token, "any", async (tx, actor) => {
    const previous = await tx.supportGrant.findUnique({
      where: { actorUserId_requestId: { actorUserId: actor.userId, requestId: parsed.requestId } },
      select: projection,
    });
    if (
      previous &&
      (!sameRequest(previous, request) ||
        previous.revokedAt ||
        previous.expiresAt.getTime() <= Date.now())
    )
      throw new AppError(
        409,
        "GRANT_REPLAY_CONFLICT",
        "This support request cannot be changed or revived"
      );
    const lifetime = Date.parse(request.expiresAt) - Date.now();
    if (lifetime <= 0 || lifetime > MAX_SUPPORT_GRANT_MS)
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Support expiry must be within the next 24 hours"
      );
    await currentCeiling(tx, actor, request);
    if (
      !(await tx.business.findFirst({
        where: { id: request.businessId, status: "active" },
        select: { id: true },
      }))
    )
      throw new NotFoundError("Workspace");
    const connectionIds = request.scope.kind === "connections" ? request.scope.connectionIds : [];
    if (
      connectionIds.length &&
      (await tx.channelConnection.count({
        where: { businessId: request.businessId, id: { in: connectionIds } },
      })) !== connectionIds.length
    )
      throw new NotFoundError("Connection");
    if (previous) return previous;
    const grant = await tx.supportGrant.create({
      data: {
        actorUserId: actor.userId,
        businessId: request.businessId,
        assignmentId: request.assignmentId,
        requestId: parsed.requestId,
        allowedOperations: request.allowedOperations,
        scopeMode: request.scope.kind,
        customerProfileAccess: request.scope.customerProfileAccess,
        reason: request.reason,
        expiresAt: new Date(request.expiresAt),
      },
    });
    if (connectionIds.length)
      await tx.grantConnectionScope.createMany({
        data: connectionIds.map((connectionId) => ({
          businessId: grant.businessId,
          grantId: grant.id,
          connectionId,
        })),
      });
    await writePlatformAudit(tx, {
      actorUserId: actor.userId,
      businessId: grant.businessId,
      grantId: grant.id,
      action: "support.issue",
      reason: request.reason,
      details: {
        grantId: grant.id,
        assignmentId: request.assignmentId,
        requestId: parsed.requestId,
        allowedOperations: request.allowedOperations,
        scope: request.scope,
        expiresAt: request.expiresAt,
      },
    });
    return tx.supportGrant.findUniqueOrThrow({ where: { id: grant.id }, select: projection });
  });
}

/** Actor can end its own grant; super admin can revoke any grant. Never revives. */
export async function revokeSupportGrant(token: string, input: unknown) {
  const request = parse(revoke, input);
  return withPlatformControl(token, "any", async (tx, actor) => {
    const grant = await tx.supportGrant.findFirst({
      where: {
        id: request.grantId,
        ...(actor.role === "super_admin" ? {} : { actorUserId: actor.userId }),
      },
      select: projection,
    });
    if (!grant) throw new NotFoundError("Support grant");
    await tx.supportGrant.updateMany({
      where: { id: grant.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await writePlatformAudit(tx, {
      actorUserId: actor.userId,
      businessId: grant.businessId,
      grantId: grant.id,
      action: "support.revoke",
      reason: request.reason,
      details: {
        grantId: grant.id,
        assignmentId: grant.assignmentId,
        targetUserId: grant.actorUserId,
      },
    });
    return tx.supportGrant.findUniqueOrThrow({ where: { id: grant.id }, select: projection });
  });
}

const admissionRequest = z
  .object({ grantId: id, businessId: id, operation: z.string().min(1).max(100) })
  .strict();

/** Fresh control-plane admission facts for the future identity resolver. This
 * function never creates TenantContext or exposes tenant data. It is not wired
 * to requests, subscriptions or jobs until those integrations enforce P1.
 */
export async function authorizeSupportUse(token: string, input: unknown) {
  const request = parse(admissionRequest, input);
  const result = await withPlatformControl(token, "any", async (tx, actor) => {
    const grant = await tx.supportGrant.findFirst({
      where: { id: request.grantId, actorUserId: actor.userId, businessId: request.businessId },
      select: projection,
    });
    if (!grant) throw new NotFoundError("Support grant");
    let pendingAuditId: string | undefined;
    try {
      const now = Date.now();
      if (grant.revokedAt || grant.expiresAt.getTime() <= now)
        throw new AppError(403, "FORBIDDEN", "Support access has ended");
      if (
        !(await tx.business.findFirst({
          where: { id: grant.businessId, status: "active" },
          select: { id: true },
        }))
      )
        throw new NotFoundError("Workspace");
      let scope = scopeFromRecord(grant);
      let allowedOperations = [...new Set(grant.allowedOperations)]
        .filter((op) => (SUPPORT_OPERATIONS as readonly string[]).includes(op))
        .sort();
      let expiresAt = grant.expiresAt;
      if (actor.role === "operator") {
        if (!grant.assignmentId)
          throw new AppError(403, "FORBIDDEN", "A current named assignment is required");
        const assignment = await tx.platformAssignment.findFirst({
          where: {
            id: grant.assignmentId,
            operatorUserId: actor.userId,
            businessId: grant.businessId,
            revokedAt: null,
          },
          include: { connectionScopes: true },
        });
        if (!assignment || (assignment.expiresAt && assignment.expiresAt.getTime() <= now))
          throw new AppError(403, "FORBIDDEN", "Support assignment has ended");
        scope = intersectResourceScopes(scopeFromRecord(assignment), scope);
        allowedOperations = allowedOperations.filter((op) =>
          assignment.allowedOperations.includes(op)
        );
        if (assignment.expiresAt && assignment.expiresAt < expiresAt)
          expiresAt = assignment.expiresAt;
      } else if (grant.assignmentId) {
        // Promotion does not convert an old operator grant to super authority.
        throw new AppError(403, "FORBIDDEN", "Support authority changed; issue a new grant");
      }
      if (!allowedOperations.includes(request.operation))
        throw new AppError(403, "FORBIDDEN", "This support operation is unavailable");
      if (scope.kind === "connections") {
        const rows = await tx.channelConnection.findMany({
          where: { businessId: grant.businessId, id: { in: scope.connectionIds } },
          select: { id: true },
        });
        scope = { ...scope, connectionIds: rows.map((row) => row.id).sort() };
        if (!scope.connectionIds.length)
          throw new AppError(403, "FORBIDDEN", "No support resources remain available");
      }
      const admission = {
        userId: actor.userId,
        businessId: grant.businessId,
        grantId: grant.id,
        scope,
        allowedOperations,
        expiresAt,
        sessionJti: actor.sessionJti,
        sessionExpiresAt: actor.sessionExpiresAt,
      };
      const admissionAudit = await writePlatformAudit(tx, {
        actorUserId: actor.userId,
        businessId: grant.businessId,
        grantId: grant.id,
        action: "support.authorize",
        reason: grant.reason,
        details: {
          decision: "allowed",
          operation: request.operation,
          grantId: grant.id,
          assignmentId: grant.assignmentId,
          allowedOperations,
          scope,
          expiresAt: expiresAt.toISOString(),
        },
      });
      pendingAuditId = admissionAudit.id;
      // Queries/audit persistence can cross expiry while the control lock is
      // held. Consumers must still reauthorize before their later tenant effect.
      const revokedSession = await tx.revokedToken.findUnique({
        where: { jti: actor.sessionJti },
        select: { jti: true },
      });
      if (revokedSession || actor.sessionExpiresAt * 1000 <= Date.now())
        throw new AppError(401, "UNAUTHORIZED", "The person session has ended");
      if (expiresAt.getTime() <= Date.now())
        throw new AppError(403, "FORBIDDEN", "Support access has ended");
      return { admission };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      // Commit owned-grant denial audit before returning the denial. Throwing
      // inside the transaction would silently roll back this audit record.
      const denial = {
        actorUserId: actor.userId,
        businessId: grant.businessId,
        grantId: grant.id,
        action: "support.deny",
        reason: grant.reason,
        details: {
          decision: "denied",
          operation: request.operation,
          grantId: grant.id,
          assignmentId: grant.assignmentId,
          code: error.code,
        },
      };
      if (pendingAuditId) {
        // Finalize only this transaction's unpublished row. Never leave a
        // successful admission audit for a decision that expired before handoff.
        await tx.platformAccessAudit.update({ where: { id: pendingAuditId }, data: denial });
      } else await writePlatformAudit(tx, denial);
      return { failure: error };
    }
  });
  if (result.failure) throw result.failure;
  return result.admission!;
}
