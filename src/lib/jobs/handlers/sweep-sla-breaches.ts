import { prisma as rawClient } from "@/lib/prisma/raw-client";
import type { TenantContext } from "@/lib/tenancy/context";
import { resolveTenantPlacement } from "@/lib/platform/tenant-placement";
import { checkSLABreaches } from "@/lib/conversations/conversation-engine";
import { jobQueue } from "@/lib/jobs/queue";
import { SWEEP_SLA_BREACHES_JOB } from "@/lib/jobs/job-types";
import { logger } from "@/lib/observability/logger";

/**
 * PLAN.md §25.2/§46.6 PR2 task 12 — `checkSLABreaches()` (§2.4) had zero
 * callers before this phase. This is the recurring sweep that finally
 * calls it, for every business: "platform/control-plane Business lookup →
 * resolve TenantPlacement → construct tenant/system context → execute
 * tenant-scoped business logic" (§25.2's own sequence) — never a raw
 * cross-tenant data-plane query for convenience.
 *
 * Runs as one recurring job handler invocation iterating every business
 * in-process (§46.6's own "Risks" note: acceptable for MVP scale; per-
 * business fan-out is a noted Phase 8 candidate, not built speculatively
 * now), rather than fanning out into one job per business.
 */
export async function runSlaBreachSweep(): Promise<void> {
  const businesses = await rawClient.business.findMany({ where: { status: "active" }, select: { id: true } });

  let totalEscalated = 0;
  for (const business of businesses) {
    try {
      const placement = await resolveTenantPlacement(business.id);
      const ctx: TenantContext = {
        businessId: business.id,
        role: null,
        actor: { kind: "system_job", jobId: "sweep-sla-breaches", jobType: SWEEP_SLA_BREACHES_JOB },
        dataConnection: placement.dataConnection,
      };
      totalEscalated += await checkSLABreaches(ctx);
    } catch (error) {
      // One business's failure must not stop the sweep for the rest (§31.3's
      // "a single [unit] down must not affect other" principle).
      logger.error("[sweep-sla-breaches] failed for one business", { businessId: business.id, error });
    }
  }

  logger.info("[sweep-sla-breaches] sweep complete", { businessCount: businesses.length, totalEscalated });
}

jobQueue.registerHandler(SWEEP_SLA_BREACHES_JOB, async () => {
  await runSlaBreachSweep();
});
