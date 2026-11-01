import { prisma } from "@/lib/prisma/raw-client";
import { AppError } from "@/lib/observability/errors";
import { lockTenantWrites } from "@/lib/tenancy/work-lifecycle";
import { entitledLimit } from "./entitlements";

/**
 * L5.2 - the only writers of `Membership.suspendedByPlanAt`: a member the owner did not keep when the seat limit dropped holds no seat
 * and cannot enter the workspace. Nothing is deleted. Both writers run under the workspace write fence.
 */

export const seatsInUse = (tx: Pick<typeof prisma, "membership" | "accountToken">, businessId: string) =>
  Promise.all([
    tx.membership.count({ where: { businessId, suspendedByPlanAt: null } }),
    tx.accountToken.count({ where: { purpose: "invitation", usedAt: null, expiresAt: { gt: new Date() }, payload: { path: ["businessId"], equals: businessId } } }),
  ]);

/** Gives a suspended member their seat back, if the plan has room. */
export async function restoreMember(ctx: { businessId: string }, membershipId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockTenantWrites(tx, ctx.businessId);
    const m = await tx.membership.findFirst({ where: { id: membershipId, businessId: ctx.businessId, suspendedByPlanAt: { not: null } }, select: { id: true } });
    if (!m) throw new AppError(404, "NOT_FOUND", "That member is not suspended");
    const [[held, invited], limit] = await Promise.all([seatsInUse(tx, ctx.businessId), entitledLimit(ctx.businessId, "seats.members", tx)]);
    if (held + invited >= limit) throw new AppError(403, "ENTITLEMENT_REQUIRED", "This workspace's package has no free team seat", { capability: "seats.members" });
    await tx.membership.update({ where: { id: m.id }, data: { suspendedByPlanAt: null } });
  });
}

/** Suspends everyone but the kept members and the owners. The caller holds the workspace write fence in the same transaction. */
export async function suspendUnchosen(tx: Pick<typeof prisma, "membership">, businessId: string, keep: string[], now: Date): Promise<void> {
  await tx.membership.updateMany({ where: { businessId, suspendedByPlanAt: null, role: { not: "owner" }, id: { notIn: keep } }, data: { suspendedByPlanAt: now } });
}
