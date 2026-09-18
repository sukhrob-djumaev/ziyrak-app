import { logger } from "@/lib/observability/logger";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

export async function logActivity(
  ctx: TenantContext,
  action: string,
  entity: string,
  entityId: string | null,
  description: string,
  userName?: string
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
        userName: userName || "System",
      },
    });
  } catch (error) {
    logger.error("Failed to log activity", error);
  }
}
