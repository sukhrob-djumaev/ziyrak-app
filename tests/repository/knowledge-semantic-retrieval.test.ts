import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * Proof that `KnowledgeRetriever.retrieve()` actually ranks by stored entry
 * embeddings once the indexing job has run — not merely that an embedding
 * column is non-null (PLAN.md §22.1/§22.2/§44.1 "real semantic retrieval").
 *
 * The fixture is built so that keyword scoring and embedding scoring
 * disagree: the intended entry shares *no* query word, while a decoy shares
 * *every* query word but is about something else. `ConceptEmbeddingProvider`
 * (tests/helpers/embedding-fakes.ts) maps "money back" and "reimbursed" onto
 * the same concept, so only the embedding path can pick the intended entry.
 * Entries are created through the real service and indexed through the real
 * job handler; real Postgres throughout.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { encryptEmbeddingProviderCredential } from "@/lib/ai/config";
import * as knowledgeService from "@/lib/knowledge/service";
import { knowledgeRetriever } from "@/lib/knowledge/retriever";
import { readStoredEmbedding } from "@/lib/knowledge/indexing";
import { jobQueue } from "@/lib/jobs/queue";
import type { FakeJobQueue } from "@/lib/jobs/fake-job-queue";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { ConceptEmbeddingProvider, routeEmbeddingRegistry } from "../helpers/embedding-fakes";

const fakeQueue = jobQueue as FakeJobQueue;
const QUERY = "How do I get my money back";

let semantic: SeededBusiness; // has an embedding provider configured
let keywordOnly: SeededBusiness; // identical knowledge, no embedding provider
let other: SeededBusiness; // a third business holding a perfect semantic match of its own
let registrySpy: ReturnType<typeof routeEmbeddingRegistry>;
const ids: Record<string, Record<string, string>> = {};

async function seedKnowledge(business: SeededBusiness, label: string) {
  const category = await getScopedPrisma(business.ctx).category.create({ data: { name: `semantic-${label}` } });
  const create = (title: string, content: string) =>
    knowledgeService.createEntry(business.ctx, { categoryId: category.id, title, content }).then((e) => e.id);
  ids[label] = {
    // Intended answer: zero words in common with the query.
    refund: await create("Reimbursement policy", "Purchases are reimbursed in full within thirty days of delivery."),
    // Decoy: every query word (how, get, money, back) appears, but it is about remittances.
    decoy: await create("Money transfers back home", "How to get an international wire to family abroad."),
    filler1: await create("Pets", "Dogs and cats are welcome in the shop."),
    filler2: await create("Opening hours", "We open at nine and stay open through the weekend."),
    filler3: await create("Courier", "Every parcel is handed to a courier for shipping."),
  };
  await fakeQueue.__drainForTests();
}

beforeAll(async () => {
  semantic = await seedBusiness("semantic-retrieval");
  keywordOnly = await seedBusiness("semantic-retrieval-keyword-only");
  other = await seedBusiness("semantic-retrieval-other");

  for (const business of [semantic, other]) {
    const embeddingCredentialRef = await encryptEmbeddingProviderCredential("openai", `sk-${business.businessId}`);
    await getScopedPrisma(business.ctx).businessConfig.upsert({
      where: { businessId: business.businessId },
      update: { embeddingProvider: "openai", embeddingCredentialRef },
      create: { businessId: business.businessId, embeddingProvider: "openai", embeddingCredentialRef },
    });
  }
  registrySpy = routeEmbeddingRegistry((apiKey) => new ConceptEmbeddingProvider(apiKey));

  await seedKnowledge(semantic, "semantic");
  await seedKnowledge(keywordOnly, "keywordOnly");
  // The other business holds an even stronger refund match.
  const otherCategory = await getScopedPrisma(other.ctx).category.create({ data: { name: "other" } });
  ids.other = {
    refund: (await knowledgeService.createEntry(other.ctx, { categoryId: otherCategory.id, title: "Refunds", content: "Refunds: money back, reimbursed, refunded." })).id,
  };
  await fakeQueue.__drainForTests();
});

afterAll(async () => {
  registrySpy.mockRestore();
  for (const b of [semantic, keywordOnly, other]) await cleanupBusiness(b.businessId);
});

describe("semantic retrieval beats keyword-only retrieval (deterministic)", () => {
  it("every active entry of the semantic business was indexed by the job", async () => {
    const entries = await getScopedPrisma(semantic.ctx).knowledgeEntry.findMany({ where: { id: { in: Object.values(ids.semantic) } } });
    expect(entries).toHaveLength(5);
    for (const entry of entries) expect(readStoredEmbedding(entry.metadata)).not.toBeNull();
  });

  it("control: keyword-only retrieval (no embedding provider) ranks the decoy first and never finds the intended entry", async () => {
    const results = await knowledgeRetriever.retrieve(keywordOnly.ctx, QUERY, { limit: 5 });
    expect(results[0]?.id).toBe(ids.keywordOnly.decoy);
    expect(results.map((r) => r.id)).not.toContain(ids.keywordOnly.refund);
  });

  it("with stored embeddings, retrieve() returns the semantically intended entry first", async () => {
    const results = await knowledgeRetriever.retrieve(semantic.ctx, QUERY, { limit: 5 });
    expect(results[0]?.id).toBe(ids.semantic.refund);
    expect(results[0]!.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it("returns at most the configured limit", async () => {
    const results = await knowledgeRetriever.retrieve(semantic.ctx, QUERY, { limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(ids.semantic.refund);
  });

  it("tenant isolation still holds: another business's stronger match is never returned", async () => {
    const results = await knowledgeRetriever.retrieve(semantic.ctx, QUERY, { limit: 20 });
    expect(results.map((r) => r.id)).not.toContain(ids.other.refund);
    const otherResults = await knowledgeRetriever.retrieve(other.ctx, QUERY, { limit: 20 });
    expect(otherResults.map((r) => r.id)).toEqual([ids.other.refund]);
  });

  it("keyword fallback still works when the embedding provider is unavailable at query time", async () => {
    const failing = routeEmbeddingRegistry(() => ({
      name: "fake-concept",
      dimensions: 70,
      embed: async () => {
        throw new Error("provider down");
      },
    }));
    try {
      const results = await knowledgeRetriever.retrieve(semantic.ctx, "courier parcel shipping", { limit: 5 });
      expect(results[0]?.id).toBe(ids.semantic.filler3);
    } finally {
      failing.mockRestore();
      registrySpy = routeEmbeddingRegistry((apiKey) => new ConceptEmbeddingProvider(apiKey));
    }
  });
});

describe("query-embedding cache", () => {
  it("two different queries sharing a long common prefix never share a cached query vector", async () => {
    const prefix = "Hello there, I have a question for the shop team about ";
    const a = await knowledgeRetriever.retrieve(semantic.ctx, `${prefix}getting my money back`, { limit: 1 });
    const b = await knowledgeRetriever.retrieve(semantic.ctx, `${prefix}dogs and cats`, { limit: 1 });
    expect(a[0]?.id).toBe(ids.semantic.refund);
    expect(b[0]?.id).toBe(ids.semantic.filler1);
  });

  it("an entry indexed after a query was cached is used by the very next identical query (no stale retrieval result)", async () => {
    const query = "Do you allow dogs";
    const before = await knowledgeRetriever.retrieve(semantic.ctx, query, { limit: 10 }); // caches the query vector
    const category = await getScopedPrisma(semantic.ctx).category.create({ data: { name: "late" } });
    const late = await knowledgeService.createEntry(semantic.ctx, { categoryId: category.id, title: "Animal policy", content: "Every cat or dog may come inside." });
    await fakeQueue.__drainForTests();

    const after = await knowledgeRetriever.retrieve(semantic.ctx, query, { limit: 10 });
    expect(before.map((r) => r.id)).not.toContain(late.id);
    expect(after.map((r) => r.id)).toContain(late.id);
  });

  it("an entry edited after being cached in a result is retrieved by its new content on the next query", async () => {
    const category = await getScopedPrisma(semantic.ctx).category.create({ data: { name: "edited" } });
    const entry = await knowledgeService.createEntry(semantic.ctx, { categoryId: category.id, title: "Notice", content: "Parcel courier info." });
    await fakeQueue.__drainForTests();
    expect((await knowledgeRetriever.retrieve(semantic.ctx, "shipping by courier", { limit: 10 })).map((r) => r.id)).toContain(entry.id);

    await knowledgeService.updateEntry(semantic.ctx, entry.id, { content: "We now open late on the weekend." });
    await fakeQueue.__drainForTests();
    const after = await knowledgeRetriever.retrieve(semantic.ctx, "shipping by courier", { limit: 10 });
    expect(after.map((r) => r.id)).not.toContain(entry.id);
    expect((await knowledgeRetriever.retrieve(semantic.ctx, "weekend opening", { limit: 10 })).map((r) => r.id)).toContain(entry.id);
  });
});
