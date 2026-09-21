import { prisma as rawClient } from "@/lib/prisma/raw-client";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { resolveTenantPlacement } from "@/lib/platform/tenant-placement";
import { applyRetentionPolicy } from "@/lib/customers/gdpr";
import { jobQueue } from "@/lib/jobs/queue";
import { SWEEP_RETENTION_JOB } from "@/lib/jobs/job-types";
import { logger } from "@/lib/observability/logger";

/**
 * PLAN.md §25.2/§46.6 PR2 task 12 — `applyRetentionPolicy()` (§2.4) had
 * zero callers before this phase. Same per-business sweep shape as
 * `sweep-sla-breaches.ts`; the one addition is reading each business's own
 * `retentionDays` from `BusinessConfig` (§25.2's own wording) — `null`
 * means no policy configured, so the sweep skips that business entirely
 * rather than guessing a default and deleting data nobody asked to purge.
 */
export async function runRetentionSweep(): Promise<void> {
  const businesses = await rawClient.business.findMany({ where: { status: "active" }, select: { id: true } });

  let processed = 0;
  for (const business of businesses) {
    try {
      const placement = await resolveTenantPlacement(business.id);
      const ctx: TenantContext = {
        businessId: business.id,
        role: null,
        actor: { kind: "system_job", jobId: "sweep-retention", jobType: SWEEP_RETENTION_JOB },
        dataConnection: placement.dataConnection,
      };

      const config = await getScopedPrisma(ctx).businessConfig.findUnique({ where: { businessId: business.id } });
      if (!config?.retentionDays) continue; // no retention policy configured for this business

      await applyRetentionPolicy(ctx, config.retentionDays);
      processed++;
    } catch (error) {
      logger.error("[sweep-retention] failed for one business", { businessId: business.id, error });
    }
  }

  logger.info("[sweep-retention] sweep complete", { businessCount: businesses.length, processed });
}

jobQueue.registerHandler(SWEEP_RETENTION_JOB, async () => {
  await runRetentionSweep();
});
