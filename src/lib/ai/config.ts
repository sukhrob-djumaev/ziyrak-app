import { z } from "zod";
import { prisma as rawPrisma } from "@/lib/prisma/raw-client";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { getDefaultBusinessId } from "@/lib/tenancy/default-business";
import type { TenantContext } from "@/lib/tenancy/context";
import { getSecretResolver, type EncryptedSecret } from "@/lib/secrets";
import { logger } from "@/lib/observability/logger";
import { PLATFORM_AI_DEFAULTS } from "@/lib/platform/defaults";
import {
  AIProviderCredentialSchema,
  EmbeddingProviderCredentialSchema,
  type AIProviderCredential,
  type EmbeddingProviderCredential,
} from "./providers/credentials";

/**
 * PLAN.md §46.4/§10.2/§10.4 — resolves a business's real, tenant-scoped AI
 * generation/embedding configuration: `PlatformDefaults` merged under
 * `BusinessConfig` (§10.2), with the credential resolved through
 * `SecretResolver` (§10.3) rather than the legacy global `Settings.
 * aiApiKey` this replaces as the source of truth.
 *
 * Precedence (Phase 1's implementation record: "Settings.aiApiKey ... Phase
 * 4 must migrate it ... Do not leave two silent sources of truth"):
 *   1. `BusinessConfig.aiCredentialRef`/`embeddingCredentialRef` (any
 *      business) — the real, permanent home for this config now.
 *   2. The legacy `Settings` singleton, but ONLY for the Default Business,
 *      and ONLY as long as that business has not touched its own
 *      `BusinessConfig` AI fields at all yet (§13's "no two silent sources
 *      of truth" — once a business sets its own `aiProvider`/credential,
 *      the legacy row is never consulted for it again, even if the
 *      credential fails to decrypt).
 *   3. Not configured (`apiKey: null`) — every other case, including every
 *      non-Default business with no `BusinessConfig` credential of its own.
 * This is what actually retires the Phase 2 `assertDefaultBusinessOnly()`
 * guard on `/api/chat`/`/api/knowledge/test` (§46.2's audit) — every
 * business now resolves its own config instead of only the Default
 * Business being able to reach the still-global `Settings` row.
 */

export interface ResolvedAIConfig {
  provider: string;
  model: string;
  maxTokens: number;
  temperature: number;
  apiKey: string | null;
}

export interface ResolvedEmbeddingConfig {
  provider: string;
  apiKey: string | null;
}

/**
 * The setup wizard historically stored Anthropic's selection as `"claude"`
 * (`setup/page.tsx`'s old `PROVIDER_OPTIONS`) — `AIProviderRegistry` is
 * keyed by `"anthropic"` (matching `AnthropicProvider.name`). Any legacy
 * `Settings.aiProvider` value of `"claude"` is normalized here so the
 * registry lookup succeeds instead of throwing "unknown provider" for a
 * business that configured Claude before this phase.
 */
const LEGACY_PROVIDER_ALIASES: Record<string, string> = { claude: "anthropic" };

function normalizeProviderName(name: string): string {
  return LEGACY_PROVIDER_ALIASES[name] ?? name;
}

async function decryptCredential<T extends { provider: string; apiKey: string }>(
  ref: string,
  schema: z.ZodType<T>,
  expectedProvider: string
): Promise<string | null> {
  try {
    const encrypted = JSON.parse(ref) as EncryptedSecret;
    const plaintext = await getSecretResolver().decrypt(encrypted);
    const parsed = schema.parse(JSON.parse(plaintext));
    if (parsed.provider !== expectedProvider) {
      logger.error(
        `AI credential provider mismatch: stored for "${parsed.provider}", requested for "${expectedProvider}".`
      );
      return null;
    }
    return parsed.apiKey;
  } catch (error) {
    logger.error("Failed to decrypt/validate AI provider credential:", error);
    return null;
  }
}

export async function encryptAIProviderCredential(provider: string, apiKey: string): Promise<string> {
  const credential: AIProviderCredential = AIProviderCredentialSchema.parse({ provider, apiKey });
  const encrypted = await getSecretResolver().encrypt(JSON.stringify(credential));
  return JSON.stringify(encrypted);
}

export async function encryptEmbeddingProviderCredential(provider: string, apiKey: string): Promise<string> {
  const credential: EmbeddingProviderCredential = EmbeddingProviderCredentialSchema.parse({ provider, apiKey });
  const encrypted = await getSecretResolver().encrypt(JSON.stringify(credential));
  return JSON.stringify(encrypted);
}

interface LegacyAIConfig {
  provider: string;
  model: string;
  maxTokens: number;
  temperature: number;
  apiKey: string;
}

/**
 * The one remaining legitimate read of the legacy global `Settings` row for
 * AI config — narrowly scoped (Default Business only) and only consulted
 * when that business hasn't started using its own `BusinessConfig` yet (see
 * this module's own header comment on precedence). Not a general-purpose
 * fallback: `resolveAIConfig`/`resolveEmbeddingConfig` are the only callers.
 */
async function resolveLegacySettings(ctx: TenantContext): Promise<LegacyAIConfig | null> {
  const defaultBusinessId = await getDefaultBusinessId();
  if (ctx.businessId !== defaultBusinessId) return null;

  const settings = await rawPrisma.settings.findUnique({ where: { id: "default" } });
  if (!settings?.aiApiKey) return null;

  return {
    provider: settings.aiProvider,
    model: settings.aiModel,
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
    apiKey: settings.aiApiKey,
  };
}

export async function resolveAIConfig(ctx: TenantContext): Promise<ResolvedAIConfig> {
  const db = getScopedPrisma(ctx);
  const config = await db.businessConfig.findUnique({ where: { businessId: ctx.businessId } });

  const provider = normalizeProviderName(config?.aiProvider ?? PLATFORM_AI_DEFAULTS.aiProvider);
  const model = config?.aiModel ?? PLATFORM_AI_DEFAULTS.aiModel;
  const maxTokens = config?.maxTokens ?? PLATFORM_AI_DEFAULTS.maxTokens;
  const temperature = config?.temperature ?? PLATFORM_AI_DEFAULTS.temperature;

  if (config?.aiCredentialRef) {
    const apiKey = await decryptCredential(config.aiCredentialRef, AIProviderCredentialSchema, provider);
    return { provider, model, maxTokens, temperature, apiKey };
  }

  // Only fall back to the legacy singleton if this business has never
  // touched its own BusinessConfig AI fields — once it has (even without a
  // credential yet), the legacy row is no longer a silent second source of
  // truth for it.
  const hasOwnAIConfig = Boolean(config?.aiProvider);
  if (!hasOwnAIConfig) {
    const legacy = await resolveLegacySettings(ctx);
    if (legacy) {
      return {
        provider: normalizeProviderName(legacy.provider),
        model: legacy.model,
        maxTokens: legacy.maxTokens,
        temperature: legacy.temperature,
        apiKey: legacy.apiKey,
      };
    }
  }

  return { provider, model, maxTokens, temperature, apiKey: null };
}

export async function resolveEmbeddingConfig(ctx: TenantContext): Promise<ResolvedEmbeddingConfig> {
  const db = getScopedPrisma(ctx);
  const config = await db.businessConfig.findUnique({ where: { businessId: ctx.businessId } });

  const generationProvider = normalizeProviderName(config?.aiProvider ?? PLATFORM_AI_DEFAULTS.aiProvider);
  const provider = normalizeProviderName(config?.embeddingProvider ?? generationProvider);

  if (config?.embeddingCredentialRef) {
    const apiKey = await decryptCredential(config.embeddingCredentialRef, EmbeddingProviderCredentialSchema, provider);
    return { provider, apiKey };
  }

  // §22.2 — reuse the generation credential for embeddings when the
  // resolved embedding provider is the same provider and no separate
  // embedding key was configured, so a business with one OpenAI key
  // doesn't need to enter it twice.
  if (config?.aiCredentialRef && provider === generationProvider) {
    const apiKey = await decryptCredential(config.aiCredentialRef, AIProviderCredentialSchema, provider);
    if (apiKey) return { provider, apiKey };
  }

  const hasOwnEmbeddingConfig = Boolean(config?.embeddingProvider || config?.aiCredentialRef);
  if (!hasOwnEmbeddingConfig) {
    const legacy = await resolveLegacySettings(ctx);
    if (legacy) return { provider, apiKey: legacy.apiKey };
  }

  return { provider, apiKey: null };
}
