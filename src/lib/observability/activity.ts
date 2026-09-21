import type { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/observability/logger";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

function defaultActorName(ctx: TenantContext): string {
  switch (ctx.actor.kind) {
    case "ai_agent":
      return "AI Assistant";
    case "api_key":
      return "API";
    default:
      return "System";
  }
}

/**
 * PLAN.md §38.1/§44.3/§46.7 — the durable, tenant-scoped "who did what, when"
 * trail. Best-effort by design: an audit-write failure is logged, never
 * allowed to fail the customer-facing operation it describes. `businessId`
 * comes only from `ctx` (never a caller argument), so a row can never be
 * attributed to a different tenant than the one acting; `userId` is recorded
 * only when the actor is a signed-in human.
 */
export async function logActivity(
  ctx: TenantContext,
  action: string,
  entity: string,
  entityId: string | null,
  description: string,
  userName?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    const db = getScopedPrisma(ctx);
    await db.activityLog.create({
      data: {
        businessId: ctx.businessId,
        action,
        entity,
        entityId,
        description,
        userName: userName || defaultActorName(ctx),
        ...(ctx.actor.kind === "user" && { userId: ctx.actor.userId }),
        ...(metadata && { metadata: metadata as Prisma.InputJsonValue }),
      },
    });
  } catch (error) {
    logger.error("Failed to log activity", error);
  }
}
