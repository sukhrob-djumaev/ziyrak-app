import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * PLAN.md P2 / proposal section 2 — a managed workspace resolves the platform
 * service policy, never its own BusinessConfig provider/model/key and never
 * another workspace's key. legacy_byok and no-allowance workspaces are unchanged.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { resolveAIConfig, resolveEmbeddingConfig, encryptAIProviderCredential, encryptEmbeddingProviderCredential } from "@/lib/ai/config";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { acquirePolicyLock, releasePolicyLock } from "../helpers/policy-lock";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let a: SeededBusiness;
let b: SeededBusiness;

async function activePolicy(kind: "generation" | "embedding", provider: string, model: string, key: string) {
  const credentialRef =
    kind === "generation"
      ? await encryptAIProviderCredential(provider, key)
      : await encryptEmbeddingProviderCredential(provider, key);
  await prisma.aiServicePolicy.updateMany({ where: { kind }, data: { active: false } });
  const last = await prisma.aiServicePolicy.findFirst({ where: { kind }, orderBy: { version: "desc" } });
  return prisma.aiServicePolicy.create({
    data: { kind, version: (last?.version ?? 0) + 1, active: true, displayName: "Standard", provider, model, credentialRef, maxTokens: 321, temperature: 0.2 },
  });
}

beforeAll(async () => {
  await acquirePolicyLock();
  a = await seedBusiness("ai-managed-a");
  b = await seedBusiness("ai-managed-b");
});
afterAll(async () => {
  await prisma.aiServicePolicy.deleteMany({});
  await cleanupBusiness(a.businessId);
  await cleanupBusiness(b.businessId);
  await releasePolicyLock();
});
beforeEach(async () => {
  await prisma.aiServicePolicy.deleteMany({});
  await prisma.workspaceAiAllowance.deleteMany({ where: { businessId: { in: [a.businessId, b.businessId] } } });
  const dbA = getScopedPrisma(a.ctx);
  await dbA.businessConfig.upsert({
    where: { businessId: a.businessId },
    create: { businessId: a.businessId },
    update: {},
  });
  await prisma.businessConfig.update({
    where: { businessId: a.businessId },
    data: {
      aiProvider: "anthropic",
      aiModel: "tenant-model",
      aiCredentialRef: await encryptAIProviderCredential("anthropic", "tenant-own-key"),
      embeddingProvider: null,
      embeddingCredentialRef: null,
    },
  });
});

describe("managed generation resolution", () => {
  it("uses the platform policy and ignores the workspace's own provider, model and key", async () => {
    await activePolicy("generation", "openai", "gpt-policy", "platform-key");
    await prisma.workspaceAiAllowance.create({ data: { businessId: a.businessId, mode: "managed" } });
    const cfg = await resolveAIConfig(a.ctx);
    expect(cfg).toMatchObject({ managed: true, provider: "openai", model: "gpt-policy", apiKey: "platform-key", maxTokens: 321, temperature: 0.2 });
  });

  it("fails clearly (no key) when the managed workspace has no active policy, never using its own key", async () => {
    await prisma.workspaceAiAllowance.create({ data: { businessId: a.businessId, mode: "managed" } });
    const cfg = await resolveAIConfig(a.ctx);
    expect(cfg.managed).toBe(true);
    expect(cfg.apiKey).toBeNull();
  });

  it("a policy whose credential is for another provider resolves to no key", async () => {
    const p = await activePolicy("generation", "openai", "m", "k");
    await prisma.aiServicePolicy.update({ where: { id: p.id }, data: { provider: "anthropic" } });
    await prisma.workspaceAiAllowance.create({ data: { businessId: a.businessId, mode: "managed" } });
    expect((await resolveAIConfig(a.ctx)).apiKey).toBeNull();
  });

  it("legacy_byok keeps the workspace's own configuration", async () => {
    await activePolicy("generation", "openai", "gpt-policy", "platform-key");
    await prisma.workspaceAiAllowance.create({ data: { businessId: a.businessId, mode: "legacy_byok" } });
    const cfg = await resolveAIConfig(a.ctx);
    expect(cfg).toMatchObject({ managed: false, provider: "anthropic", model: "tenant-model", apiKey: "tenant-own-key" });
  });

  it("a workspace with no allowance row is unchanged (legacy)", async () => {
    await activePolicy("generation", "openai", "gpt-policy", "platform-key");
    const cfg = await resolveAIConfig(a.ctx);
    expect(cfg).toMatchObject({ managed: false, apiKey: "tenant-own-key" });
  });

  it("another workspace never receives a different workspace's own key", async () => {
    await prisma.workspaceAiAllowance.create({ data: { businessId: b.businessId, mode: "managed" } });
    const cfg = await resolveAIConfig(b.ctx);
    expect(cfg.apiKey).toBeNull();
  });
});

describe("managed embedding resolution", () => {
  it("uses the embedding policy", async () => {
    await activePolicy("embedding", "openai", "emb-model", "platform-emb-key");
    await prisma.workspaceAiAllowance.create({ data: { businessId: a.businessId, mode: "managed" } });
    expect(await resolveEmbeddingConfig(a.ctx)).toMatchObject({ managed: true, provider: "openai", apiKey: "platform-emb-key" });
  });

  it("has no key without an active embedding policy, even if the workspace has its own", async () => {
    await prisma.workspaceAiAllowance.create({ data: { businessId: a.businessId, mode: "managed" } });
    const cfg = await resolveEmbeddingConfig(a.ctx);
    expect(cfg.managed).toBe(true);
    expect(cfg.apiKey).toBeNull();
  });
});
