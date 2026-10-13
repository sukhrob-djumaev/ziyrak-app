import { prisma as rawClient } from "@/lib/prisma/raw-client";
import { AIProviderError } from "@/lib/ai/providers/types";

/**
 * PLAN.md §11/§46.9 — per-business infrastructure overrides, read from the
 * control plane only. A business with no `InfrastructurePolicy` row (the
 * shared-tenant majority) is never restricted and costs one primary-key read.
 *
 * Provider allowlists are enforced here, at the two call sites that turn a
 * configured provider name into a provider (generation in `ai/engine.ts`,
 * embeddings in `knowledge/indexing.ts`), not inside the registries: the
 * registries are keyed by provider name with no business context, and the
 * policy lookup is async. An empty list means "no restriction" for that
 * capability; generation and embedding are checked independently (§21.5).
 */
export interface InfrastructurePolicyRecord {
  businessId: string;
  dataRegion: string | null;
  permittedAiProviders: string[];
  permittedEmbeddingProviders: string[];
}

export async function getInfrastructurePolicy(businessId: string): Promise<InfrastructurePolicyRecord | null> {
  return rawClient.infrastructurePolicy.findUnique({ where: { businessId } });
}

async function assertPermitted(
  businessId: string,
  capability: "AI" | "embedding",
  providerName: string,
  pick: (policy: InfrastructurePolicyRecord) => string[]
): Promise<void> {
  const policy = await getInfrastructurePolicy(businessId);
  if (!policy) return;
  const allowed = pick(policy);
  if (allowed.length === 0 || allowed.includes(providerName)) return;
  throw new AIProviderError(
    "invalid_request",
    `The ${capability} provider "${providerName}" is not permitted for this business by its infrastructure policy.`,
    false
  );
}

export function assertAiProviderPermitted(businessId: string, providerName: string): Promise<void> {
  return assertPermitted(businessId, "AI", providerName, (p) => p.permittedAiProviders);
}

export function assertEmbeddingProviderPermitted(businessId: string, providerName: string): Promise<void> {
  return assertPermitted(businessId, "embedding", providerName, (p) => p.permittedEmbeddingProviders);
}
