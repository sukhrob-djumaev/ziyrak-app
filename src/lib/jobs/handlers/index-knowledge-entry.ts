import type { TenantContext } from "@/lib/tenancy/context";
import { indexKnowledgeEntry, redactProviderMessage } from "@/lib/knowledge/indexing";
import { logger } from "@/lib/observability/logger";
import { jobQueue } from "@/lib/jobs/queue";
import { INDEX_KNOWLEDGE_ENTRY_JOB, type IndexKnowledgeEntryPayload } from "@/lib/jobs/job-types";

/**
 * PLAN.md §25.2 — the `index-knowledge-entry` job: embeds one knowledge
 * entry's current content with its own business's `EmbeddingProvider` and
 * stores it with provenance (`knowledge/indexing.ts`).
 *
 * Retry policy (§31.1, `jobs/queue-config.ts`): only a *retryable*
 * provider failure (rate limit, timeout, 5xx, dropped connection) is
 * rethrown so pg-boss retries it with backoff; everything else — no
 * provider configured, an unsupported provider, a bad key, an unusable
 * vector, an entry deleted/deactivated/edited meanwhile — completes the
 * job. In every failure case the entry stays saved and keyword-retrievable
 * and nothing is stored, so a retry or a later re-enqueue can still
 * populate it. Logs carry businessId/knowledgeEntryId/provider/outcome,
 * never the entry text or any credential.
 */
export async function handleIndexKnowledgeEntry(ctx: TenantContext, payload: IndexKnowledgeEntryPayload): Promise<void> {
  // The queue resolves ctx from payload.businessId; refuse anything else
  // rather than index under a context the payload didn't name.
  if (ctx.businessId !== payload.businessId) {
    throw new Error("[index-knowledge-entry] tenant context does not match the job's businessId; refusing to run.");
  }

  const outcome = await indexKnowledgeEntry(ctx, payload.entryId);
  const fields = { businessId: payload.businessId, knowledgeEntryId: payload.entryId, provider: "provider" in outcome ? outcome.provider : undefined };

  switch (outcome.status) {
    case "indexed":
      logger.info("[index-knowledge-entry] embedding stored", { ...fields, model: outcome.model, outcome: "indexed" });
      return;
    case "already_current":
    case "stale":
      logger.info("[index-knowledge-entry] nothing to store", { ...fields, outcome: outcome.status });
      return;
    case "skipped":
      logger.info("[index-knowledge-entry] skipped; entry stays keyword-retrievable", { ...fields, outcome: "skipped", reason: outcome.reason });
      return;
    case "failed":
      if (outcome.retryable) {
        logger.warn("[index-knowledge-entry] embedding failed; the queue will retry", {
          ...fields,
          outcome: "retrying",
          code: outcome.code,
          error: redactProviderMessage(outcome.message),
        });
        throw new Error(`[index-knowledge-entry] retryable embedding failure (${outcome.code})`);
      }
      logger.error("[index-knowledge-entry] embedding failed permanently; entry stays keyword-retrievable", undefined, {
        ...fields,
        outcome: "failed",
        code: outcome.code,
        error: redactProviderMessage(outcome.message),
      });
      return;
  }
}

jobQueue.registerHandler<IndexKnowledgeEntryPayload>(INDEX_KNOWLEDGE_ENTRY_JOB, handleIndexKnowledgeEntry);
