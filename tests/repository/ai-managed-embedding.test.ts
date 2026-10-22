import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/** PLAN.md P2 — embedding calls (indexing and query-time) are metered for managed workspaces. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { indexKnowledgeEntry } from "@/lib/knowledge/indexing";
import { embeddingProviderRegistry } from "@/lib/ai/providers/embedding-registry";
import { OpenAIEmbeddingProvider } from "@/lib/ai/providers/openai-embedding";
import { FakeEmbeddingProvider } from "@/lib/ai/providers/fake";
import { encryptEmbeddingProviderCredential } from "@/lib/ai/config";
import { knowledgeRetriever } from "@/lib/knowledge/retriever";
import { getAllowanceUsage } from "@/lib/ai/allowance";
import { acquirePolicyLock, releasePolicyLock } from "../helpers/policy-lock";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let a: SeededBusiness;
let entryId: string;
let fake: FakeEmbeddingProvider;

beforeAll(async () => {
  await acquirePolicyLock();
  a = await seedBusiness("ai-managed-embedding");
  embeddingProviderRegistry.register("openai", () => fake);
});
afterAll(async () => {
  embeddingProviderRegistry.register("openai", ({ apiKey }) => new OpenAIEmbeddingProvider(apiKey));
  await prisma.aiServicePolicy.deleteMany({});
  await cleanupBusiness(a.businessId);
  await releasePolicyLock();
});
beforeEach(async () => {
  fake = new FakeEmbeddingProvider(8);
  await prisma.aiServicePolicy.deleteMany({});
  await prisma.aiServicePolicy.create({
    data: {
      kind: "embedding",
      version: 1,
      active: true,
      displayName: "Standard",
      provider: "openai",
      model: "emb",
      credentialRef: await encryptEmbeddingProviderCredential("openai", "platform-emb-key"),
    },
  });
  await prisma.aiUsageReservation.deleteMany({ where: { businessId: a.businessId } });
  await prisma.workspaceAiAllowance.upsert({
    where: { businessId: a.businessId },
    create: { businessId: a.businessId, mode: "managed", embeddingLimitTokens: 100_000 },
    update: { mode: "managed", status: "active", embeddingLimitTokens: 100_000 },
  });
  const category = await prisma.category.create({ data: { businessId: a.businessId, name: `c-${Date.now()}-${Math.random()}` } });
  const entry = await prisma.knowledgeEntry.create({
    data: { businessId: a.businessId, categoryId: category.id, title: "Refunds", content: "We refund within 30 days of purchase." },
  });
  entryId = entry.id;
});

describe("managed embedding indexing", () => {
  it("settles the provider-reported embedding usage", async () => {
    const outcome = await indexKnowledgeEntry(a.ctx, entryId);
    expect(outcome.status).toBe("indexed");
    const usage = await getAllowanceUsage(a.businessId, "embedding");
    expect(usage.reserved).toBe(0);
    expect(usage.used).toBeGreaterThan(0);
    expect(usage.used).toBeLessThan(100);
  });

  it("does not call the provider when the allowance is exhausted, and stores no vector", async () => {
    await prisma.workspaceAiAllowance.update({ where: { businessId: a.businessId }, data: { embeddingLimitTokens: 1 } });
    const outcome = await indexKnowledgeEntry(a.ctx, entryId);
    expect(outcome).toMatchObject({ status: "skipped", reason: "allowance_unavailable" });
    expect(fake.requests).toHaveLength(0);
  });

  it("an unmanaged workspace never touches the ledger", async () => {
    await prisma.workspaceAiAllowance.update({ where: { businessId: a.businessId }, data: { mode: "legacy_byok" } });
    await indexKnowledgeEntry(a.ctx, entryId);
    expect(await prisma.aiUsageReservation.count({ where: { businessId: a.businessId } })).toBe(0);
  });
});

describe("managed query-time embedding", () => {
  it("meters a query embedding, and falls back to keyword search without a provider call when exhausted", async () => {
    const hit = await knowledgeRetriever.retrieve(a.ctx, "refund purchase", { limit: 3 });
    expect(hit.length).toBeGreaterThan(0);
    expect(fake.requests).toHaveLength(1);
    expect((await getAllowanceUsage(a.businessId, "embedding")).used).toBeGreaterThan(0);

    await prisma.workspaceAiAllowance.update({ where: { businessId: a.businessId }, data: { embeddingLimitTokens: 1 } });
    fake.requests.length = 0;
    const fallback = await knowledgeRetriever.retrieve(a.ctx, "a different refund question", { limit: 3 });
    expect(fake.requests).toHaveLength(0);
    expect(fallback.length).toBeGreaterThan(0);
  });
});
