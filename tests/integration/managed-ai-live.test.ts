import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * Credential-gated LIVE smoke test for PLAN.md P2: the managed path through
 * real OpenAI. A platform policy (key from OPENAI_API_KEY, encrypted exactly as
 * the platform console stores it) serves a managed workspace; one real chat()
 * generation and one real knowledge-entry embedding must settle real usage in
 * the ledger, and an exhausted allowance must stop paid work. Runs only via
 *
 *   OPENAI_API_KEY=sk-... npx vitest run --config vitest.integration.config.ts tests/integration/managed-ai-live.test.ts
 *
 * Skips without a key; refuses OPENAI_BASE_URL (a stand-in is not OpenAI).
 * Cost: one short chat completion and one embedding.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { chat } from "@/lib/ai/engine";
import { encryptAIProviderCredential, encryptEmbeddingProviderCredential } from "@/lib/ai/config";
import { getAllowanceUsage } from "@/lib/ai/allowance";
import * as knowledgeService from "@/lib/knowledge/service";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { readStoredEmbedding } from "@/lib/knowledge/indexing";
import { jobQueue } from "@/lib/jobs/queue";
import type { FakeJobQueue } from "@/lib/jobs/fake-job-queue";
import { acquirePolicyLock, releasePolicyLock } from "../helpers/policy-lock";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

const apiKey = process.env.OPENAI_API_KEY;

describe.skipIf(!apiKey)("LIVE smoke test: managed AI path -> real OpenAI", () => {
  let business: SeededBusiness;

  beforeAll(async () => {
    if (process.env.OPENAI_BASE_URL) throw new Error("Unset OPENAI_BASE_URL — this smoke test must reach the real OpenAI API.");
    await acquirePolicyLock();
    business = await seedBusiness("managed-ai-live");
    await prisma.aiServicePolicy.deleteMany({});
    await prisma.aiServicePolicy.create({
      data: {
        kind: "generation", version: 1, active: true, displayName: "Live check", provider: "openai", model: "gpt-4o-mini",
        credentialRef: await encryptAIProviderCredential("openai", apiKey!), maxTokens: 60, temperature: 0,
      },
    });
    await prisma.aiServicePolicy.create({
      data: {
        kind: "embedding", version: 1, active: true, displayName: "Live check", provider: "openai", model: "text-embedding-3-small",
        credentialRef: await encryptEmbeddingProviderCredential("openai", apiKey!),
      },
    });
    await prisma.workspaceAiAllowance.create({
      data: { businessId: business.businessId, mode: "managed", generationLimitTokens: 50_000, embeddingLimitTokens: 50_000 },
    });
  });
  afterAll(async () => {
    await prisma.aiServicePolicy.deleteMany({});
    if (business) await cleanupBusiness(business.businessId);
    await releasePolicyLock();
  });

  it("answers through the platform key and settles the provider-reported usage", async () => {
    const convo = await prisma.conversation.create({
      data: { businessId: business.businessId, channel: "webchat", customerName: "Live", customerContact: "live" },
    });
    const reply = await chat(business.ctx, convo.id, "Say hello in one short sentence.");
    expect(reply.length).toBeGreaterThan(0);
    expect(reply).not.toMatch(/not configured|unable to continue|temporarily unable/i);
    const usage = await getAllowanceUsage(business.businessId, "generation");
    const logged = await prisma.aIInteractionLog.findFirstOrThrow({ where: { businessId: business.businessId, kind: "generation" } });
    expect(usage.reserved).toBe(0);
    expect(usage.used).toBe(logged.totalTokens);
    expect(usage.used).toBeGreaterThan(0);
  });

  it("embeds a knowledge entry through the platform key and settles usage", async () => {
    const category = await getScopedPrisma(business.ctx).category.create({ data: { name: "live" } });
    const entry = await knowledgeService.createEntry(business.ctx, {
      categoryId: category.id, title: "Reimbursement policy", content: "Purchases are reimbursed in full within thirty days.",
    });
    await (jobQueue as FakeJobQueue).__drainForTests();
    const row = await getScopedPrisma(business.ctx).knowledgeEntry.findUnique({ where: { id: entry.id } });
    expect(readStoredEmbedding(row!.metadata)?.vector).toHaveLength(1536);
    const usage = await getAllowanceUsage(business.businessId, "embedding");
    expect(usage.used).toBeGreaterThan(0);
    expect(usage.reserved).toBe(0);
  });

  it("stops paid work once the allowance is exhausted", async () => {
    await prisma.workspaceAiAllowance.update({ where: { businessId: business.businessId }, data: { generationLimitTokens: 1 } });
    const before = await getAllowanceUsage(business.businessId, "generation");
    const convo = await prisma.conversation.create({
      data: { businessId: business.businessId, channel: "webchat", customerName: "Live", customerContact: "live2" },
    });
    const reply = await chat(business.ctx, convo.id, "Say hello again.");
    expect(reply).toMatch(/team member/i);
    expect((await getAllowanceUsage(business.businessId, "generation")).used).toBe(before.used);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: convo.id } })).status).toBe("escalated");
  });
});
