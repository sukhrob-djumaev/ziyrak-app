import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma/raw-client";
import type { TenantContext } from "@/lib/tenancy/context";
import { TEST_DEFAULT_BUSINESS_ID } from "../setup";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
const mockFetchFn = vi.fn();

vi.mock("@/lib/ai/config", () => ({
  resolveEmbeddingConfig: vi.fn(),
}));

const ctx: TenantContext = {
  businessId: TEST_DEFAULT_BUSINESS_ID,
  role: "owner",
  actor: { kind: "user", userId: "test-user" },
  dataConnection: "shared-default",
};

function entry(overrides: Partial<{ id: string; title: string; content: string; priority: number; metadata: Record<string, unknown> }> = {}) {
  return {
    id: overrides.id ?? "entry-1",
    title: overrides.title ?? "Return Policy",
    content: overrides.content ?? "30-day returns allowed",
    priority: overrides.priority ?? 0,
    metadata: overrides.metadata ?? {},
    category: { name: "FAQ" },
  };
}

describe("searchKnowledgeBase (§46.4/§22.2)", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    mockPrisma.knowledgeEntry.findMany.mockReset();
    mockFetchFn.mockReset();
    vi.stubGlobal("fetch", mockFetchFn);

    const { resolveEmbeddingConfig } = await import("@/lib/ai/config");
    vi.mocked(resolveEmbeddingConfig).mockResolvedValue({ provider: "openai", apiKey: null });
  });

  it("returns an empty array when the business has no active entries", async () => {
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([]);
    const { searchKnowledgeBase } = await import("@/lib/knowledge/semantic-search");
    expect(await searchKnowledgeBase(ctx, "anything")).toEqual([]);
  });

  it("falls back to keyword matching when no embedding provider is configured, and never calls fetch()", async () => {
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([
      entry({ id: "1", title: "Return Policy", content: "You can return items within 30 days" }),
      entry({ id: "2", title: "Shipping", content: "We ship worldwide" }),
    ]);

    const { searchKnowledgeBase } = await import("@/lib/knowledge/semantic-search");
    const results = await searchKnowledgeBase(ctx, "return policy days");

    expect(results.map((r) => r.id)).toContain("1");
    expect(mockFetchFn).not.toHaveBeenCalled();
  });

  it("routes the query embedding through the tenant's EmbeddingProvider, never a direct OpenAI fetch", async () => {
    const { resolveEmbeddingConfig } = await import("@/lib/ai/config");
    vi.mocked(resolveEmbeddingConfig).mockResolvedValue({ provider: "openai", apiKey: "sk-test" });

    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([
      entry({ id: "1", metadata: { embedding: [1, 0, 0] } }),
      entry({ id: "2", metadata: { embedding: [0, 1, 0] } }),
    ]);

    const embedSpy = vi.fn().mockResolvedValue({ vector: [1, 0, 0], model: "test", usage: { totalTokens: 3 } });
    const { embeddingProviderRegistry } = await import("@/lib/ai/providers/embedding-registry");
    vi.spyOn(embeddingProviderRegistry, "get").mockReturnValue({ name: "openai", dimensions: 3, embed: embedSpy });

    const { searchKnowledgeBase } = await import("@/lib/knowledge/semantic-search");
    const results = await searchKnowledgeBase(ctx, "test query");

    expect(embedSpy).toHaveBeenCalledWith("test query");
    expect(mockFetchFn).not.toHaveBeenCalled();
    // Entry 1's embedding is identical to the query's — highest cosine similarity.
    expect(results[0].id).toBe("1");
  });

  it("falls back to keyword scoring for an entry with no stored embedding, even when the query embedding succeeded", async () => {
    const { resolveEmbeddingConfig } = await import("@/lib/ai/config");
    vi.mocked(resolveEmbeddingConfig).mockResolvedValue({ provider: "openai", apiKey: "sk-test" });

    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([
      entry({ id: "no-embedding", title: "shipping rates", content: "shipping rates info", metadata: {} }),
    ]);

    const embedSpy = vi.fn().mockResolvedValue({ vector: [1, 0, 0], model: "test", usage: { totalTokens: 3 } });
    const { embeddingProviderRegistry } = await import("@/lib/ai/providers/embedding-registry");
    vi.spyOn(embeddingProviderRegistry, "get").mockReturnValue({ name: "openai", dimensions: 3, embed: embedSpy });

    const { searchKnowledgeBase } = await import("@/lib/knowledge/semantic-search");
    const results = await searchKnowledgeBase(ctx, "shipping rates");

    expect(results.map((r) => r.id)).toContain("no-embedding");
  });

  it("bounds results to the requested limit, even with many matching entries", async () => {
    const { resolveEmbeddingConfig } = await import("@/lib/ai/config");
    vi.mocked(resolveEmbeddingConfig).mockResolvedValue({ provider: "openai", apiKey: null });

    const entries = Array.from({ length: 100 }, (_, i) =>
      entry({ id: `entry-${i}`, title: "order status", content: "order status information" })
    );
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue(entries);

    const { searchKnowledgeBase } = await import("@/lib/knowledge/semantic-search");
    const results = await searchKnowledgeBase(ctx, "order status", 5);

    expect(results).toHaveLength(5);
  });

  it("includes each result's priority (§22.1's KnowledgeItem shape)", async () => {
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([
      entry({ id: "1", title: "policy", content: "policy text", priority: 7 }),
    ]);
    const { searchKnowledgeBase } = await import("@/lib/knowledge/semantic-search");
    const results = await searchKnowledgeBase(ctx, "policy");
    expect(results[0].priority).toBe(7);
  });
});
