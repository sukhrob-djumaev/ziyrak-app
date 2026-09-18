import type { TenantContext } from "@/lib/tenancy/context";

/**
 * PLAN.md §46.3 (Phase 3) / §22.1 — module-boundary sketch, not a frozen
 * contract. Per review concern 22, Phase 3 fixes only this contract's
 * module location (`knowledge/`, absorbing `ai/semantic-search.ts` — §6)
 * and that it depends on `tenancy/` and `ai/` (for `EmbeddingProvider`,
 * §21.5). No implementation exists yet; that is Phase 4 scope (§46.4),
 * which rewires `semantic-search.ts`'s already-working retrieval logic
 * onto this interface and onto `EmbeddingProvider` instead of calling
 * OpenAI's embeddings endpoint directly (§22.2).
 *
 * `KnowledgeItem` here is the target *scored* retrieval shape (§22.1) and
 * is deliberately distinct from `ai/types.ts`'s `KnowledgeItem` (today's
 * unscored, unbounded-dump shape still used by `knowledge/retrieval.ts`'s
 * `getKnowledgeBase()`, moved verbatim in this phase per its own "no
 * behavior change" requirement) — Phase 4 unifies the two when
 * `getKnowledgeBase()` is deleted (§22.2).
 */
export interface KnowledgeItem {
  id: string;
  title: string;
  content: string;
  category: string;
  priority: number;
  score: number;
}

/** Illustrative only (§22.1) — finalized in Phase 4. */
export interface KnowledgeRetriever {
  retrieve(ctx: TenantContext, query: string, options?: { limit?: number }): Promise<KnowledgeItem[]>;
}
