import { prisma as rawPrisma } from "@/lib/prisma/raw-client";
import { resolveTenantPlacement } from "@/lib/platform/tenant-placement";
import type { TenantContext } from "@/lib/tenancy/context";
import { logger } from "@/lib/observability/logger";
import type { KnowledgeReindexResult } from "./indexing";
import { reindexStaleEntries } from "./service";

/**
 * Operator backfill for stored knowledge embeddings (`scripts/reindex-knowledge.ts`):
 * run once after this feature ships so entries created before it are indexed,
 * and again after an embedding provider/model change.
 *
 * The only cross-tenant step is listing which businesses to visit — a
 * control-plane `Business` query, the same justification as the SLA/retention
 * sweeps (`jobs/handlers/sweep-*.ts`). Each business is then handled through
 * its own resolved `TenantContext` and the tenant-scoped
 * `enqueueKnowledgeReindex(ctx)`, so no business's scan ever reads or
 * queues another's entries. A failure for one business is reported and does
 * not stop the rest. Safe to rerun: current entries are never queued.
 */
export type BusinessBackfillOutcome =
  | { businessId: string; status: "done"; result: KnowledgeReindexResult }
  | { businessId: string; status: "error"; error: string }
  | { businessId: string; status: "not_found_or_inactive" };

export async function backfillKnowledgeEmbeddings(options: { businessIds?: string[] } = {}): Promise<BusinessBackfillOutcome[]> {
  const businesses = await rawPrisma.business.findMany({
    where: { status: "active", ...(options.businessIds ? { id: { in: options.businessIds } } : {}) },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  const outcomes: BusinessBackfillOutcome[] = [];
  if (options.businessIds) {
    const found = new Set(businesses.map((b) => b.id));
    for (const id of options.businessIds) if (!found.has(id)) outcomes.push({ businessId: id, status: "not_found_or_inactive" });
  }

  for (const { id: businessId } of businesses) {
    try {
      const placement = await resolveTenantPlacement(businessId);
      const ctx: TenantContext = {
        businessId,
        role: null,
        actor: { kind: "system_job", jobId: `knowledge-reindex-${Date.now()}`, jobType: "knowledge-reindex" },
        dataConnection: placement.dataConnection,
      };
      outcomes.push({ businessId, status: "done", result: await reindexStaleEntries(ctx) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[knowledge-backfill] business failed; continuing with the rest", undefined, { businessId, error: message });
      outcomes.push({ businessId, status: "error", error: message });
    }
  }
  return outcomes;
}
