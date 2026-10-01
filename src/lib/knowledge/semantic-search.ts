/**
 * Semantic Search for Knowledge Base
 *
 * Uses the tenant's configured EmbeddingProvider for vector similarity
 * search (§46.4/§21.5/§22.2). Falls back to keyword matching when no
 * embedding provider is configured for the business, or when an individual
 * entry has no *usable* stored embedding — none yet (its indexing job
 * hasn't run or failed), or one produced for different text or by a
 * different provider/model than the query's (see `knowledge/indexing.ts`).
 *
 * Embeddings are stored in the KnowledgeEntry metadata field as JSON,
 * written by the `index-knowledge-entry` job (`knowledge/indexing.ts`).
 * For production with pgvector, store in a dedicated vector column (§22.3 —
 * deferred, not needed at MVP knowledge-base sizes).
 */

import crypto from "crypto";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { TenantContext } from "@/lib/tenancy/context";
import { cacheGet, cacheSet } from "@/lib/cache";
import { logger } from "@/lib/observability/logger";
import { recordAIInteraction } from "@/lib/ai/usage";
import { isEmbeddingUsable, readStoredEmbedding, redactProviderMessage, resolveTenantEmbeddingProvider } from "./indexing";

interface SearchResult {
  id: string;
  title: string;
  content: string;
  category: string;
  priority: number;
  score: number;
}

interface CachedQueryEmbedding {
  vector: number[];
  model: string;
}

function parseCachedQueryEmbedding(raw: string): CachedQueryEmbedding | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CachedQueryEmbedding>;
    if (Array.isArray(parsed.vector) && typeof parsed.model === "string") return { vector: parsed.vector, model: parsed.model };
  } catch {
    // fall through — an unreadable cache entry is just a miss
  }
  return null;
}

/**
 * Calculate cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Keyword-based search fallback.
 */
function keywordScore(query: string, text: string): number {
  const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const textLower = text.toLowerCase();
  let matches = 0;

  for (const word of queryWords) {
    if (textLower.includes(word)) matches++;
  }

  return queryWords.length > 0 ? matches / queryWords.length : 0;
}

/**
 * Search the knowledge base semantically, tenant-scoped. Uses the tenant's
 * configured EmbeddingProvider when available, falls back to keyword
 * matching when no embedding provider is configured, or an individual
 * entry has no stored embedding yet.
 */
export async function searchKnowledgeBase(
  ctx: TenantContext,
  query: string,
  limit = 5
): Promise<SearchResult[]> {
  const db = getScopedPrisma(ctx);
  const entries = await db.knowledgeEntry.findMany({
    where: { isActive: true },
    include: { category: { select: { name: true } } },
  });

  if (entries.length === 0) return [];

  const resolved = await resolveTenantEmbeddingProvider(ctx);
  const embeddingProvider = resolved.status === "available" ? resolved.provider : null;

  let results: SearchResult[];

  if (embeddingProvider) {
    // Cache key is tenant- and provider-scoped (two businesses, or a
    // business that later switches embedding provider, must never share a
    // cached vector) and keyed by a hash of the *whole* query — a key built
    // from a truncated prefix let two different questions with the same
    // opening words share one vector. Only the query vector is cached;
    // entries and their stored embeddings are read fresh on every call, so
    // a newly indexed or edited entry is reflected on the very next query.
    const queryHash = crypto.createHash("sha256").update(query).digest("hex");
    const cacheKey = `embedding:${ctx.businessId}:${embeddingProvider.name}:${queryHash}`;
    let queryEmbedding: CachedQueryEmbedding | null = null;

    const cached = await cacheGet(cacheKey);
    if (cached) queryEmbedding = parseCachedQueryEmbedding(cached);
    if (!queryEmbedding) {
      const embedded = await embeddingProvider.embed(query).catch((error) => {
        logger.error("Failed to generate query embedding, falling back to keyword search", {
          businessId: ctx.businessId,
          provider: embeddingProvider.name,
          error: redactProviderMessage(error instanceof Error ? error.message : String(error)),
        });
        return null;
      });
      if (embedded && embedded.vector.length > 0) {
        queryEmbedding = { vector: embedded.vector, model: embedded.model };
        await cacheSet(cacheKey, JSON.stringify(queryEmbedding), 3600);
        await recordAIInteraction(ctx, {
          kind: "embedding",
          provider: embeddingProvider.name,
          model: embedded.model,
          totalTokens: embedded.usage.totalTokens,
        });
      }
    }

    if (queryEmbedding) {
      const resolvedEmbedding = queryEmbedding;
      // Score each entry by cosine similarity when its stored embedding is
      // usable for this query (same text, provider, model, dimensions);
      // otherwise by keyword, exactly as before indexing existed.
      results = entries.map((entry) => {
        const stored = readStoredEmbedding(entry.metadata);
        const score = isEmbeddingUsable(stored, entry, {
          provider: embeddingProvider.name,
          model: resolvedEmbedding.model,
          dimensions: resolvedEmbedding.vector.length,
        })
          ? cosineSimilarity(resolvedEmbedding.vector, stored.vector)
          : keywordScore(query, `${entry.title} ${entry.content}`);

        return {
          id: entry.id,
          title: entry.title,
          content: entry.content,
          category: entry.category.name,
          priority: entry.priority,
          score,
        };
      });
    } else {
      // Embedding generation failed, use keyword search
      results = keywordSearch(entries, query);
    }
  } else {
    // No (supported) embedding provider configured for this business, use keyword search
    results = keywordSearch(entries, query);
  }

  return results
    .filter((r) => r.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function keywordSearch(
  entries: Array<{
    id: string;
    title: string;
    content: string;
    priority: number;
    category: { name: string };
  }>,
  query: string
): SearchResult[] {
  return entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    content: entry.content,
    category: entry.category.name,
    priority: entry.priority,
    score: keywordScore(query, `${entry.title} ${entry.content}`),
  }));
}
