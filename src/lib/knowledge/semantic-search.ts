/**
 * Semantic Search for Knowledge Base
 *
 * Uses the tenant's configured EmbeddingProvider for vector similarity
 * search (§46.4/§21.5/§22.2). Falls back to keyword matching when no
 * embedding provider is configured for the business, or when an individual
 * entry has no stored embedding yet.
 *
 * Embeddings are stored in the KnowledgeEntry metadata field as JSON.
 * For production with pgvector, store in a dedicated vector column (§22.3 —
 * deferred, not needed at MVP knowledge-base sizes).
 */

import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { TenantContext } from "@/lib/tenancy/context";
import { cacheGet, cacheSet } from "@/lib/cache";
import { logger } from "@/lib/observability/logger";
import { resolveEmbeddingConfig } from "@/lib/ai/config";
import { embeddingProviderRegistry } from "@/lib/ai/providers/embedding-registry";
import type { EmbeddingProvider } from "@/lib/ai/providers/types";
import { recordAIInteraction } from "@/lib/ai/usage";

interface SearchResult {
  id: string;
  title: string;
  content: string;
  category: string;
  priority: number;
  score: number;
}

/** Resolves the tenant's own EmbeddingProvider, or null if none is configured for this business. */
async function resolveTenantEmbeddingProvider(ctx: TenantContext): Promise<EmbeddingProvider | null> {
  const config = await resolveEmbeddingConfig(ctx);
  if (!config.apiKey) return null;
  return embeddingProviderRegistry.get(config.provider, { apiKey: config.apiKey });
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

  const embeddingProvider = await resolveTenantEmbeddingProvider(ctx);

  let results: SearchResult[];

  if (embeddingProvider) {
    // Cache key is tenant- and provider-scoped: two businesses (or a
    // business that later switches embedding provider) must never share a
    // cached vector, since different providers/keys can yield different
    // embeddings for the same text.
    const cacheKey = `embedding:${ctx.businessId}:${embeddingProvider.name}:${Buffer.from(query).toString("base64").substring(0, 50)}`;
    let queryEmbedding: number[] | null = null;

    const cached = await cacheGet(cacheKey);
    if (cached) {
      queryEmbedding = JSON.parse(cached);
    } else {
      const embedded = await embeddingProvider.embed(query).catch((error) => {
        logger.error("Failed to generate query embedding, falling back to keyword search:", error);
        return null;
      });
      queryEmbedding = embedded?.vector ?? null;
      if (queryEmbedding && embedded) {
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
      // Score entries using embeddings (stored in metadata) + keyword fallback
      results = entries.map((entry) => {
        const metadata = entry.metadata as Record<string, unknown> | null;
        const entryEmbedding = metadata?.embedding as number[] | null;

        const score = entryEmbedding
          ? cosineSimilarity(resolvedEmbedding, entryEmbedding)
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
    // No embedding provider configured for this business, use keyword search
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

/**
 * Generate and store embedding for a knowledge entry, using the tenant's
 * own configured EmbeddingProvider.
 */
export async function indexKnowledgeEntry(ctx: TenantContext, entryId: string): Promise<boolean> {
  const db = getScopedPrisma(ctx);
  const entry = await db.knowledgeEntry.findUnique({
    where: { id: entryId },
  });

  if (!entry) return false;

  const embeddingProvider = await resolveTenantEmbeddingProvider(ctx);
  if (!embeddingProvider) return false;

  const text = `${entry.title}\n${entry.content}`;
  const embedded = await embeddingProvider.embed(text).catch((error) => {
    logger.error("Failed to generate knowledge entry embedding:", error);
    return null;
  });
  if (!embedded) return false;

  await recordAIInteraction(ctx, {
    kind: "embedding",
    provider: embeddingProvider.name,
    model: embedded.model,
    totalTokens: embedded.usage.totalTokens,
  });

  const currentMetadata = (entry.metadata as Record<string, unknown>) || {};

  await db.knowledgeEntry.update({
    where: { id: entryId },
    data: {
      metadata: { ...currentMetadata, embedding: embedded.vector },
    },
  });

  return true;
}
