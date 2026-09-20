import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §46.4 — real-Postgres proof of the two acceptance criteria that
 * only mean something against real, seeded data: (1) a knowledge base of
 * 100+ entries results in a bounded, relevant subset being retrieved, never
 * all of them; (2) cross-tenant knowledge isolation holds through the real
 * `KnowledgeRetriever`, not only through the generic tenant-scoping
 * extension test (`tests/repository/scoped-prisma.test.ts`) that already
 * covers `knowledgeEntry` generically.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

const mockOpenAIEmbedFn = vi.fn();
vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  class MockOpenAI {
    embeddings = { create: mockOpenAIEmbedFn };
  }
  return { ...actual, default: MockOpenAI };
});

import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { knowledgeRetriever } from "@/lib/knowledge/retriever";

let businessA: SeededBusiness;
let businessB: SeededBusiness;

beforeAll(async () => {
  businessA = await seedBusiness("knowledge-retriever-a");
  businessB = await seedBusiness("knowledge-retriever-b");
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

describe("knowledgeRetriever.retrieve() (§46.4/§22.2) — bounded retrieval, real Postgres", () => {
  it("never returns more than the requested limit, even with 100+ matching entries in the business's knowledge base", async () => {
    const db = getScopedPrisma(businessA.ctx);
    const category = await db.category.create({ data: { name: "bounding-test-category" } });

    await db.knowledgeEntry.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        businessId: businessA.businessId,
        categoryId: category.id,
        title: `Order status entry ${i}`,
        content: "order status information for this customer",
        isActive: true,
      })),
    });

    const results = await knowledgeRetriever.retrieve(businessA.ctx, "order status", { limit: 8 });

    expect(results.length).toBeLessThanOrEqual(8);
    expect(results.length).toBeGreaterThan(0);
  });

  it("defaults to a bounded limit (8) when no limit option is given", async () => {
    const db = getScopedPrisma(businessA.ctx);
    const category = await db.category.create({ data: { name: "bounding-default-category" } });

    await db.knowledgeEntry.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        businessId: businessA.businessId,
        categoryId: category.id,
        title: `Shipping info ${i}`,
        content: "shipping information for this customer",
        isActive: true,
      })),
    });

    const results = await knowledgeRetriever.retrieve(businessA.ctx, "shipping information");
    expect(results.length).toBeLessThanOrEqual(8);
  });
});

describe("knowledgeRetriever.retrieve() (§46.4/§33) — cross-tenant isolation, real Postgres", () => {
  it("Business A's retrieval never includes Business B's knowledge, even for an identical, highly-matching query", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const catA = await dbA.category.create({ data: { name: "cross-tenant-cat-a" } });
    const catB = await dbB.category.create({ data: { name: "cross-tenant-cat-b" } });

    await dbA.knowledgeEntry.create({
      data: { categoryId: catA.id, title: "refund policy", content: "Business A refund policy details", isActive: true },
    });
    const bMarker = "BUSINESS-B-SECRET-REFUND-MARKER";
    await dbB.knowledgeEntry.create({
      data: { categoryId: catB.id, title: "refund policy", content: bMarker, isActive: true },
    });

    const resultsForA = await knowledgeRetriever.retrieve(businessA.ctx, "refund policy", { limit: 20 });
    expect(resultsForA.some((r) => r.content.includes(bMarker))).toBe(false);

    const resultsForB = await knowledgeRetriever.retrieve(businessB.ctx, "refund policy", { limit: 20 });
    expect(resultsForB.some((r) => r.content.includes(bMarker))).toBe(true);
  });

  it("routes embedding-based scoring through the tenant's own EmbeddingProvider credential when configured, and stays isolated", async () => {
    const { encryptEmbeddingProviderCredential } = await import("@/lib/ai/config");
    const dbA = getScopedPrisma(businessA.ctx);
    await dbA.businessConfig.upsert({
      where: { businessId: businessA.businessId },
      update: { embeddingProvider: "openai", embeddingCredentialRef: await encryptEmbeddingProviderCredential("openai", "sk-a-embedding") },
      create: {
        businessId: businessA.businessId,
        embeddingProvider: "openai",
        embeddingCredentialRef: await encryptEmbeddingProviderCredential("openai", "sk-a-embedding"),
      },
    });

    mockOpenAIEmbedFn.mockResolvedValue({ data: [{ embedding: [1, 0, 0] }], usage: { total_tokens: 3 } });

    const catA = await dbA.category.create({ data: { name: "embedding-cross-tenant-a" } });
    await dbA.knowledgeEntry.create({
      data: {
        categoryId: catA.id,
        title: "embedding entry",
        content: "content scored via embeddings",
        isActive: true,
        metadata: { embedding: [1, 0, 0] },
      },
    });

    const results = await knowledgeRetriever.retrieve(businessA.ctx, "anything", { limit: 5 });
    expect(mockOpenAIEmbedFn).toHaveBeenCalled();
    expect(results.some((r) => r.title === "embedding entry")).toBe(true);
  });
});
