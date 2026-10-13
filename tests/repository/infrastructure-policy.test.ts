import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §46.9 tasks 1 and 5 — `InfrastructurePolicy` and its AI/embedding
 * provider allowlists, against real Postgres. Generation and embedding are
 * independent capabilities (§21.5), so each allowlist is tested to block (and
 * permit) without affecting the other; a business with no policy row is
 * completely unaffected (the shared-tenant majority, §46.9 acceptance).
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import {
  getInfrastructurePolicy,
  assertAiProviderPermitted,
  assertEmbeddingProviderPermitted,
} from "@/lib/platform/infrastructure-policy";
import { AIProviderError } from "@/lib/ai/providers/types";
import { encryptEmbeddingProviderCredential } from "@/lib/ai/config";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { resolveTenantEmbeddingProvider } from "@/lib/knowledge/indexing";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let unrestricted: SeededBusiness;
let restricted: SeededBusiness;

beforeAll(async () => {
  unrestricted = await seedBusiness("infra-policy-none");
  restricted = await seedBusiness("infra-policy-restricted");
  await prisma.infrastructurePolicy.create({
    data: {
      businessId: restricted.businessId,
      permittedAiProviders: ["ollama"],
      permittedEmbeddingProviders: ["openai"],
      dataRegion: "eu",
    },
  });
});

afterAll(async () => {
  await cleanupBusiness(unrestricted.businessId);
  await cleanupBusiness(restricted.businessId);
});

describe("getInfrastructurePolicy", () => {
  it("returns null for a business with no policy row", async () => {
    expect(await getInfrastructurePolicy(unrestricted.businessId)).toBeNull();
  });

  it("returns the stored policy", async () => {
    const policy = await getInfrastructurePolicy(restricted.businessId);
    expect(policy).toMatchObject({ permittedAiProviders: ["ollama"], permittedEmbeddingProviders: ["openai"], dataRegion: "eu" });
  });
});

describe("provider allowlists (§46.9 task 5)", () => {
  it("never restricts a business with no policy", async () => {
    await expect(assertAiProviderPermitted(unrestricted.businessId, "openai")).resolves.toBeUndefined();
    await expect(assertEmbeddingProviderPermitted(unrestricted.businessId, "openai")).resolves.toBeUndefined();
  });

  it("blocks a generation provider outside the allowlist with a non-retryable error, and permits one inside it", async () => {
    await expect(assertAiProviderPermitted(restricted.businessId, "openai")).rejects.toMatchObject({
      name: "AIProviderError",
      code: "invalid_request",
      retryable: false,
    });
    await expect(assertAiProviderPermitted(restricted.businessId, "openai")).rejects.toBeInstanceOf(AIProviderError);
    await expect(assertAiProviderPermitted(restricted.businessId, "ollama")).resolves.toBeUndefined();
  });

  it("blocks an embedding provider independently of the generation allowlist", async () => {
    // "openai" is forbidden for generation but allowed for embeddings here.
    await expect(assertEmbeddingProviderPermitted(restricted.businessId, "openai")).resolves.toBeUndefined();
    await expect(assertEmbeddingProviderPermitted(restricted.businessId, "cohere")).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
    });
  });

  it("treats an empty allowlist as unrestricted for that capability", async () => {
    await prisma.infrastructurePolicy.update({ where: { businessId: restricted.businessId }, data: { permittedAiProviders: [] } });
    await expect(assertAiProviderPermitted(restricted.businessId, "openai")).resolves.toBeUndefined();
    await expect(assertEmbeddingProviderPermitted(restricted.businessId, "cohere")).rejects.toBeInstanceOf(AIProviderError);
  });
});

describe("allowlist is enforced where a configured provider becomes a provider (embeddings)", () => {
  it("resolves the business's own embedding provider only while the policy permits it", async () => {
    const db = getScopedPrisma(restricted.ctx);
    const embeddingCredentialRef = await encryptEmbeddingProviderCredential("openai", "sk-test-not-real");
    await db.businessConfig.upsert({
      where: { businessId: restricted.businessId },
      update: { embeddingProvider: "openai", embeddingCredentialRef },
      create: { businessId: restricted.businessId, embeddingProvider: "openai", embeddingCredentialRef },
    });

    await prisma.infrastructurePolicy.update({ where: { businessId: restricted.businessId }, data: { permittedEmbeddingProviders: ["openai"] } });
    expect(await resolveTenantEmbeddingProvider(restricted.ctx)).toMatchObject({ status: "available" });

    await prisma.infrastructurePolicy.update({ where: { businessId: restricted.businessId }, data: { permittedEmbeddingProviders: ["cohere"] } });
    expect(await resolveTenantEmbeddingProvider(restricted.ctx)).toEqual({ status: "not_permitted", providerName: "openai" });

    // The unrestricted business is untouched by the other business's policy.
    expect((await resolveTenantEmbeddingProvider(unrestricted.ctx)).status).not.toBe("not_permitted");
  });
});
