import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * Credential-gated LIVE smoke test for knowledge-entry indexing (PLAN.md
 * §21.5/§25.2/§34.2): one real entry, embedded by the real
 * `OpenAIEmbeddingProvider` through the real `index-knowledge-entry`
 * handler, stored in real Postgres, then retrieved by a paraphrase that
 * shares no keyword with it.
 *
 * Like the other files under tests/integration/, it is structurally
 * excluded from the default suite (vitest.config.ts) and only runs via:
 *
 *   OPENAI_API_KEY=sk-... npm run test:smoke:openai-embedding
 *
 * It skips cleanly without a key, and refuses to run with OPENAI_BASE_URL
 * set (that would silently point the SDK at a stand-in, not OpenAI). The
 * key is read once from the environment, encrypted into the test
 * business's own BusinessConfig exactly as the settings API does, and never
 * logged or written anywhere else. Cost: two `text-embedding-3-small` calls.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { encryptEmbeddingProviderCredential } from "@/lib/ai/config";
import * as knowledgeService from "@/lib/knowledge/service";
import { knowledgeRetriever } from "@/lib/knowledge/retriever";
import { readStoredEmbedding, knowledgeContentHash } from "@/lib/knowledge/indexing";
import { jobQueue } from "@/lib/jobs/queue";
import type { FakeJobQueue } from "@/lib/jobs/fake-job-queue";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

const apiKey = process.env.OPENAI_API_KEY;

describe.skipIf(!apiKey)("LIVE smoke test: index-knowledge-entry -> OpenAIEmbeddingProvider -> real OpenAI API", () => {
  let business: SeededBusiness;

  beforeAll(async () => {
    if (process.env.OPENAI_BASE_URL) throw new Error("Unset OPENAI_BASE_URL — this smoke test must reach the real OpenAI API.");
    business = await seedBusiness("knowledge-indexing-live");
    const embeddingCredentialRef = await encryptEmbeddingProviderCredential("openai", apiKey!);
    await getScopedPrisma(business.ctx).businessConfig.upsert({
      where: { businessId: business.businessId },
      update: { embeddingProvider: "openai", embeddingCredentialRef },
      create: { businessId: business.businessId, embeddingProvider: "openai", embeddingCredentialRef },
    });
  });

  afterAll(async () => {
    if (business) await cleanupBusiness(business.businessId);
  });

  it("indexes one real entry and retrieves it by meaning", async () => {
    const category = await getScopedPrisma(business.ctx).category.create({ data: { name: "live" } });
    const title = "Reimbursement policy";
    const content = "Purchases are reimbursed in full within thirty days of delivery.";
    const entry = await knowledgeService.createEntry(business.ctx, { categoryId: category.id, title, content });
    await (jobQueue as FakeJobQueue).__drainForTests();

    const row = await getScopedPrisma(business.ctx).knowledgeEntry.findUnique({ where: { id: entry.id } });
    const stored = readStoredEmbedding(row!.metadata);
    expect(stored).not.toBeNull();
    expect(stored!.vector).toHaveLength(1536);
    expect(stored!.index).toMatchObject({ provider: "openai", model: "text-embedding-3-small", contentHash: knowledgeContentHash({ title, content }) });

    const results = await knowledgeRetriever.retrieve(business.ctx, "How can I get my money back?", { limit: 3 });
    expect(results[0]?.id).toBe(entry.id);
  });
});
