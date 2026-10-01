import crypto from "crypto";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { resolveEmbeddingConfig } from "@/lib/ai/config";
import { embeddingProviderRegistry } from "@/lib/ai/providers/embedding-registry";
import { AIProviderError, type EmbeddingProvider } from "@/lib/ai/providers/types";
import { recordAIInteraction } from "@/lib/ai/usage";
import { jobQueue } from "@/lib/jobs/queue";
import { INDEX_KNOWLEDGE_ENTRY_JOB, type IndexKnowledgeEntryPayload } from "@/lib/jobs/job-types";
import { logger } from "@/lib/observability/logger";

/**
 * Knowledge-entry embedding indexing (PLAN.md §21.5/§22.2/§25.2).
 *
 * Embeddings stay where §2.8/§22.3 put them — `KnowledgeEntry.metadata`
 * JSON, no pgvector — but every stored vector now carries its provenance
 * next to it (`metadata.embeddingIndex`): which provider/model produced
 * it, its dimensions, and a hash of the exact text it embedded. That
 * provenance is what makes the vector safe to use:
 *
 * - retrieval only trusts a vector whose content hash matches the entry's
 *   current title+content and whose provider/model match the business's
 *   current embedding provider (`isEmbeddingUsable`), and otherwise scores
 *   that entry by keyword exactly as before — so an edit, a provider
 *   switch, or an unfinished job never surfaces an entry on the strength
 *   of text it no longer contains;
 * - the indexing job writes conditionally on the title/content it actually
 *   embedded, so a slow job for an older version can never overwrite the
 *   embedding of a newer one (the write simply matches zero rows).
 *
 * Indexing is a durable job (`index-knowledge-entry`, §25.2), never an
 * embedding call inside the knowledge-editing request: the request
 * persists the entry and enqueues; the worker resolves the business's own
 * `TenantContext` and embedding configuration and stores the result.
 */

export interface KnowledgeEmbeddingIndex {
  provider: string;
  model: string;
  dimensions: number;
  contentHash: string;
  indexedAt: string;
}

export interface StoredKnowledgeEmbedding {
  vector: number[];
  index: KnowledgeEmbeddingIndex;
}

interface SearchableText {
  title: string;
  content: string;
}

/** The exact text embedded for an entry (unchanged from the pre-existing indexer). */
export function knowledgeEmbeddingText(entry: SearchableText): string {
  return `${entry.title}\n${entry.content}`;
}

export function knowledgeContentHash(entry: SearchableText): string {
  return crypto.createHash("sha256").update(knowledgeEmbeddingText(entry)).digest("hex");
}

function isValidVector(vector: unknown, expectedLength?: number): vector is number[] {
  if (!Array.isArray(vector) || vector.length === 0) return false;
  if (expectedLength !== undefined && vector.length !== expectedLength) return false;
  let nonZero = false;
  for (const v of vector) {
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
    if (v !== 0) nonZero = true;
  }
  return nonZero;
}

/**
 * Reads a stored embedding *with* its provenance. A bare `metadata.embedding`
 * array with no `embeddingIndex` (nothing in this codebase ever wrote one,
 * but a hand-edited or imported row could carry one) is unverifiable — it
 * cannot be tied to the current text or provider — and reads as absent.
 */
export function readStoredEmbedding(metadata: unknown): StoredKnowledgeEmbedding | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const { embedding, embeddingIndex } = metadata as Record<string, unknown>;
  if (!isValidVector(embedding)) return null;
  if (!embeddingIndex || typeof embeddingIndex !== "object") return null;
  const index = embeddingIndex as Record<string, unknown>;
  if (
    typeof index.provider !== "string" ||
    typeof index.model !== "string" ||
    typeof index.dimensions !== "number" ||
    typeof index.contentHash !== "string" ||
    typeof index.indexedAt !== "string" ||
    index.dimensions !== embedding.length
  ) {
    return null;
  }
  return {
    vector: embedding,
    index: {
      provider: index.provider,
      model: index.model,
      dimensions: index.dimensions,
      contentHash: index.contentHash,
      indexedAt: index.indexedAt,
    },
  };
}

/**
 * Whether a stored embedding may be compared against a query vector
 * produced by `provider`/`model` for an entry whose current text is `entry`.
 */
export function isEmbeddingUsable(
  stored: StoredKnowledgeEmbedding | null,
  entry: SearchableText,
  query: { provider: string; model?: string; dimensions: number }
): stored is StoredKnowledgeEmbedding {
  if (!stored) return false;
  return (
    stored.index.contentHash === knowledgeContentHash(entry) &&
    stored.index.provider === query.provider &&
    stored.index.dimensions === query.dimensions &&
    (query.model === undefined || stored.index.model === query.model)
  );
}

/**
 * The single definition of "this entry's stored embedding is current for
 * this business's embedding provider": same content hash, provider,
 * dimensions and (when the provider declares it) model. Used by the worker
 * (skip re-embedding) and by the reindex scan (skip enqueueing); retrieval
 * applies the same `isEmbeddingUsable` rule against the query's vector.
 */
export function isEmbeddingCurrent(
  stored: StoredKnowledgeEmbedding | null,
  entry: SearchableText,
  provider: Pick<EmbeddingProvider, "name" | "dimensions" | "model">
): boolean {
  return isEmbeddingUsable(stored, entry, { provider: provider.name, dimensions: provider.dimensions, model: provider.model });
}

/** Strips the raw vector from an entry's metadata for API responses; provenance stays visible. */
export function withoutEmbeddingVector<T extends { metadata: unknown }>(entry: T): T {
  const metadata = entry.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || !("embedding" in metadata)) return entry;
  const rest = { ...(metadata as Record<string, unknown>) };
  delete rest.embedding;
  return { ...entry, metadata: rest };
}

/**
 * Provider error messages can echo part of the credential (OpenAI's 401
 * text includes a masked key) — strip anything key-shaped and bound the
 * length before it reaches a log line.
 */
export function redactProviderMessage(message: string): string {
  return message.replace(/\b(sk|pk|rk)-[A-Za-z0-9_*\-]+/g, "$1-[redacted]").slice(0, 300);
}

export type ResolvedEmbeddingProvider =
  | { status: "available"; provider: EmbeddingProvider }
  | { status: "not_configured"; providerName: string }
  | { status: "unsupported"; providerName: string };

/**
 * Resolves the business's own `EmbeddingProvider` (§21.5) — through
 * `resolveEmbeddingConfig(ctx)`, which never falls back to another
 * business's configuration (only the Default Business can ever see the
 * legacy `Settings` key). A resolved provider name with no registered
 * implementation (e.g. a business on Anthropic generation with no separate
 * embedding key — Anthropic has no embeddings API) is "unsupported", not
 * an exception: retrieval falls back to keyword scoring and indexing skips.
 */
export async function resolveTenantEmbeddingProvider(ctx: TenantContext): Promise<ResolvedEmbeddingProvider> {
  const config = await resolveEmbeddingConfig(ctx);
  if (!config.apiKey) return { status: "not_configured", providerName: config.provider };
  if (!embeddingProviderRegistry.has(config.provider)) return { status: "unsupported", providerName: config.provider };
  return { status: "available", provider: embeddingProviderRegistry.get(config.provider, { apiKey: config.apiKey }) };
}

export type KnowledgeIndexOutcome =
  | { status: "indexed"; provider: string; model: string }
  | { status: "already_current"; provider: string }
  | { status: "skipped"; reason: "not_found" | "inactive" | "no_embedding_provider" | "unsupported_embedding_provider"; provider?: string }
  | { status: "stale"; provider: string }
  | { status: "failed"; provider: string; code: string; retryable: boolean; message: string };

/**
 * Embeds one entry's *current* content with its own business's provider and
 * stores it with provenance. Never throws for an expected condition — the
 * outcome says what happened, and the job handler decides whether a
 * failure is worth a queue retry.
 */
export async function indexKnowledgeEntry(ctx: TenantContext, entryId: string): Promise<KnowledgeIndexOutcome> {
  const db = getScopedPrisma(ctx);
  // Tenant-scoped read: another business's entry id resolves to nothing.
  const entry = await db.knowledgeEntry.findUnique({ where: { id: entryId } });
  if (!entry) return { status: "skipped", reason: "not_found" };
  if (!entry.isActive) return { status: "skipped", reason: "inactive" };

  const resolved = await resolveTenantEmbeddingProvider(ctx);
  if (resolved.status === "not_configured") {
    return { status: "skipped", reason: "no_embedding_provider", provider: resolved.providerName };
  }
  if (resolved.status === "unsupported") {
    return { status: "skipped", reason: "unsupported_embedding_provider", provider: resolved.providerName };
  }
  const provider = resolved.provider;

  // Same text, same provider/model, right shape → nothing to do (a duplicate
  // job, a re-save of unchanged text, a retry after a success that already landed).
  if (isEmbeddingCurrent(readStoredEmbedding(entry.metadata), entry, provider)) {
    return { status: "already_current", provider: provider.name };
  }

  let embedded;
  try {
    embedded = await provider.embed(knowledgeEmbeddingText(entry));
  } catch (error) {
    // An SDK/network error that isn't an AIProviderError (e.g. a dropped
    // connection) is treated as transient.
    const providerError = error instanceof AIProviderError ? error : null;
    return {
      status: "failed",
      provider: provider.name,
      code: providerError?.code ?? "unknown",
      retryable: providerError?.retryable ?? true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (!isValidVector(embedded.vector, provider.dimensions)) {
    return {
      status: "failed",
      provider: provider.name,
      code: "invalid_vector",
      retryable: false,
      message: `provider returned an unusable vector (length ${(embedded.vector as unknown[] | undefined)?.length ?? "n/a"}, expected ${provider.dimensions})`,
    };
  }

  await recordAIInteraction(ctx, {
    kind: "embedding",
    provider: provider.name,
    model: embedded.model,
    totalTokens: embedded.usage.totalTokens,
  });

  const index: KnowledgeEmbeddingIndex = {
    provider: provider.name,
    model: embedded.model,
    dimensions: embedded.vector.length,
    contentHash: knowledgeContentHash(entry),
    indexedAt: new Date().toISOString(),
  };
  const currentMetadata =
    entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata)
      ? (entry.metadata as Record<string, unknown>)
      : {};

  // Stale-write protection: only write if the entry still has exactly the
  // text that was embedded. If it was edited (or deleted) while the
  // provider call was in flight, this matches zero rows and the newer
  // version's own job owns the result. `updatedAt` is preserved — indexing
  // is not a user edit and must not reorder the knowledge list.
  const { count } = await db.knowledgeEntry.updateMany({
    where: { id: entry.id, title: entry.title, content: entry.content },
    data: {
      metadata: { ...currentMetadata, embedding: embedded.vector, embeddingIndex: { ...index } },
      updatedAt: entry.updatedAt,
    },
  });
  if (count === 0) return { status: "stale", provider: provider.name };

  return { status: "indexed", provider: provider.name, model: embedded.model };
}

/**
 * Enqueues a durable indexing job for one entry. Best-effort by design: a
 * queue failure is logged and reported (`false`), never thrown — the entry
 * is already saved and stays retrievable by keyword, and the next edit or
 * a business-wide reindex re-enqueues it.
 */
export async function enqueueKnowledgeIndexing(ctx: TenantContext, entryId: string): Promise<boolean> {
  try {
    // One *queued* job per entry (the queue's "short" policy, jobs/queue-config.ts):
    // a second request while one is still waiting joins it — harmless, since the
    // job always re-reads the entry's current text. An already-running job does
    // not block a new one, so an edit made mid-embedding still gets indexed.
    await jobQueue.enqueue<IndexKnowledgeEntryPayload>(
      INDEX_KNOWLEDGE_ENTRY_JOB,
      { businessId: ctx.businessId, entryId },
      { singletonKey: knowledgeIndexJobKey(ctx.businessId, entryId) }
    );
    return true;
  } catch (error) {
    logger.error("[knowledge-indexing] failed to enqueue indexing job; entry stays keyword-retrievable", undefined, {
      businessId: ctx.businessId,
      knowledgeEntryId: entryId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function knowledgeIndexJobKey(businessId: string, entryId: string): string {
  return `${businessId}:${entryId}`;
}

export interface KnowledgeReindexResult {
  /** Whether this business currently has an embedding provider the platform can use. */
  provider: { status: "available"; name: string; model?: string } | { status: "not_configured" | "unsupported"; name: string };
  /** Active entries evaluated. */
  examined: number;
  /** Active entries whose stored embedding is already current — not queued. */
  current: number;
  /** Entries with a missing or stale embedding for which an indexing job is now queued (or was already waiting). */
  queued: number;
  /** Entries that needed indexing but could not be enqueued (logged); a rerun retries them. */
  enqueueFailed: number;
}

const REINDEX_PAGE_SIZE = 200;

/**
 * Tenant-scoped backfill/repair: examines this business's active entries
 * only (scoped client) and queues the existing `index-knowledge-entry` job
 * for each whose stored embedding is missing or stale by `isEmbeddingCurrent`
 * — no embedding, edited since indexing, or produced by a different
 * provider/model/dimensions than the business's current provider. Current
 * entries are not queued, so rerunning is cheap and safe; queued jobs
 * re-check currentness before embedding anyway. With no usable embedding
 * provider nothing is queued (a job could only skip), and the result says
 * so. Used by AI-settings changes and the operator backfill script.
 */
export async function enqueueKnowledgeReindex(ctx: TenantContext): Promise<KnowledgeReindexResult> {
  const db = getScopedPrisma(ctx);
  const resolved = await resolveTenantEmbeddingProvider(ctx);
  const provider: KnowledgeReindexResult["provider"] =
    resolved.status === "available"
      ? { status: "available", name: resolved.provider.name, model: resolved.provider.model }
      : { status: resolved.status, name: resolved.providerName };
  const result: KnowledgeReindexResult = { provider, examined: 0, current: 0, queued: 0, enqueueFailed: 0 };

  // Paged by id so a large knowledge base is never loaded (vectors included) at once.
  let cursor: string | undefined;
  for (;;) {
    const page = await db.knowledgeEntry.findMany({
      where: { isActive: true, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, title: true, content: true, metadata: true },
      orderBy: { id: "asc" },
      take: REINDEX_PAGE_SIZE,
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    for (const entry of page) {
      result.examined++;
      if (resolved.status !== "available") continue;
      if (isEmbeddingCurrent(readStoredEmbedding(entry.metadata), entry, resolved.provider)) {
        result.current++;
      } else if (await enqueueKnowledgeIndexing(ctx, entry.id)) {
        result.queued++;
      } else {
        result.enqueueFailed++;
      }
    }
  }

  logger.info("[knowledge-indexing] reindex scan", {
    businessId: ctx.businessId,
    provider: provider.name,
    providerStatus: provider.status,
    examined: result.examined,
    current: result.current,
    queued: result.queued,
    enqueueFailed: result.enqueueFailed,
  });
  return result;
}
