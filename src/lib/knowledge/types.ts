import type { TenantContext } from "@/lib/tenancy/context";

/**
 * PLAN.md §46.4 (Phase 4) / §22.1 — the `KnowledgeRetriever` contract,
 * finalized in this phase (§46.3 deferred its exact shape here). Its
 * default implementation (`knowledge/retriever.ts`) wraps
 * `semantic-search.ts`'s already-working, now tenant-scoped and
 * `EmbeddingProvider`-routed retrieval (§22.2) — `AIOrchestrator`/`chat()`
 * (`ai/engine.ts`) calls `retrieve()` and never knows or cares whether the
 * implementation is keyword matching, embeddings-in-JSON cosine
 * similarity, or a future `PgVectorKnowledgeRetriever` (§22.3).
 */
export interface KnowledgeItem {
  id: string;
  title: string;
  content: string;
  category: string;
  priority: number;
  score: number;
}

export interface KnowledgeRetriever {
  retrieve(ctx: TenantContext, query: string, options?: { limit?: number }): Promise<KnowledgeItem[]>;
}
