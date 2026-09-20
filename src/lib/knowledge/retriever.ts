import type { TenantContext } from "@/lib/tenancy/context";
import type { KnowledgeItem, KnowledgeRetriever } from "./types";
import { searchKnowledgeBase } from "./semantic-search";

/**
 * PLAN.md §46.4/§22.2 — the default `KnowledgeRetriever`: tenant-scoped,
 * relevance-bounded, `EmbeddingProvider`-routed retrieval, replacing
 * `ai/engine.ts`'s deleted `getKnowledgeBase()` unbounded full-KB dump.
 *
 * Default limit of 8 per §46.4's own risk mitigation ("defaulting it
 * generously enough ... that small KBs are effectively unaffected") —
 * `BusinessConfig` does not yet expose a per-business override (not named
 * in §46.4's task list; the `options.limit` parameter is what a future
 * caller/UI setting would thread through).
 */
const DEFAULT_RETRIEVAL_LIMIT = 8;

export const knowledgeRetriever: KnowledgeRetriever = {
  async retrieve(ctx: TenantContext, query: string, options?: { limit?: number }): Promise<KnowledgeItem[]> {
    const limit = options?.limit ?? DEFAULT_RETRIEVAL_LIMIT;
    const results = await searchKnowledgeBase(ctx, query, limit);
    return results.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      category: r.category,
      priority: r.priority,
      score: r.score,
    }));
  },
};
