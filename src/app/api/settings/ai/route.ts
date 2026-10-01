import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { toErrorResponse } from "@/lib/observability/errors";
import { validateBody, updateAISettingsSchema } from "@/lib/validations";
import {
  defaultModelForProvider,
  encryptAIProviderCredential,
  encryptEmbeddingProviderCredential,
} from "@/lib/ai/config";
import { isSupportedAnthropicModel, unsupportedAnthropicModelMessage } from "@/lib/ai/providers/anthropic-models";
import { PLATFORM_AI_DEFAULTS } from "@/lib/platform/defaults";
import { logger } from "@/lib/observability/logger";
import { reindexStaleEntries } from "@/lib/knowledge/service";

/**
 * PLAN.md §46.4/§10.4 — the real, tenant-scoped AI provider/embedding
 * configuration boundary every business (not just the Default Business)
 * now has. Never returns a raw credential — `aiConfigured`/
 * `embeddingConfigured` report only whether one is set, matching
 * `maskSettingsSecrets()`'s existing "connected, not the value itself"
 * masking convention for the legacy `Settings` singleton (§10.3).
 */

interface AISettingsView {
  aiProvider: string;
  aiModel: string;
  embeddingProvider: string;
  maxTokens: number;
  temperature: number;
  aiConfigured: boolean;
  embeddingConfigured: boolean;
  /** False when the stored model is outside the supported catalog (e.g. a retired Claude id): it must be reselected. */
  aiModelSupported: boolean;
}

function normalizeProvider(provider: string): string {
  return provider === "claude" ? "anthropic" : provider;
}

function isSupportedModel(provider: string, model: string): boolean {
  return normalizeProvider(provider) !== "anthropic" || isSupportedAnthropicModel(model);
}

function toView(config: {
  aiProvider: string | null;
  aiModel: string | null;
  embeddingProvider: string | null;
  maxTokens: number | null;
  temperature: number | null;
  aiCredentialRef: string | null;
  embeddingCredentialRef: string | null;
}): AISettingsView {
  const aiProvider = config.aiProvider ?? PLATFORM_AI_DEFAULTS.aiProvider;
  const aiModel = config.aiModel ?? defaultModelForProvider(aiProvider);
  return {
    aiProvider,
    aiModel,
    embeddingProvider: config.embeddingProvider ?? config.aiProvider ?? PLATFORM_AI_DEFAULTS.embeddingProvider,
    maxTokens: config.maxTokens ?? PLATFORM_AI_DEFAULTS.maxTokens,
    temperature: config.temperature ?? PLATFORM_AI_DEFAULTS.temperature,
    aiConfigured: Boolean(config.aiCredentialRef),
    embeddingConfigured: Boolean(config.embeddingCredentialRef || config.aiCredentialRef),
    aiModelSupported: isSupportedModel(aiProvider, aiModel),
  };
}

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "settings:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const db = getScopedPrisma(ctx);
    const config = await db.businessConfig.upsert({
      where: { businessId: ctx.businessId },
      update: {},
      create: { businessId: ctx.businessId },
    });

    return NextResponse.json(toView(config));
  } catch (error) {
    logger.error("Failed to fetch AI settings:", error);
    return toErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  const ctx = await requireAuth(request, "settings:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const validation = validateBody(updateAISettingsSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const { aiApiKey, embeddingApiKey, ...rest } = validation.data;
    const db = getScopedPrisma(ctx);

    const existing = await db.businessConfig.upsert({
      where: { businessId: ctx.businessId },
      update: {},
      create: { businessId: ctx.businessId },
    });

    const resolvedProvider = rest.aiProvider ?? existing.aiProvider ?? PLATFORM_AI_DEFAULTS.aiProvider;
    const resolvedEmbeddingProvider =
      rest.embeddingProvider ?? existing.embeddingProvider ?? resolvedProvider;

    // A stored model is never silently swapped for another (possibly more
    // expensive) one. A save that would leave the business on an unsupported
    // Anthropic model, including a retired id saved before this catalog, is
    // refused until a supported model is explicitly selected.
    const resolvedModel = rest.aiModel ?? existing.aiModel ?? defaultModelForProvider(resolvedProvider);
    if (!isSupportedModel(resolvedProvider, resolvedModel)) {
      return NextResponse.json({ error: unsupportedAnthropicModelMessage(resolvedModel) }, { status: 400 });
    }

    const data: Record<string, unknown> = { ...rest };

    if (aiApiKey) {
      if (resolvedProvider !== "openai" && resolvedProvider !== "anthropic") {
        return NextResponse.json(
          { error: `"${resolvedProvider}" does not accept an API key yet.` },
          { status: 400 }
        );
      }
      data.aiCredentialRef = await encryptAIProviderCredential(resolvedProvider, aiApiKey);
    }

    if (embeddingApiKey) {
      if (resolvedEmbeddingProvider !== "openai") {
        return NextResponse.json(
          { error: `"${resolvedEmbeddingProvider}" is not a supported embedding provider.` },
          { status: 400 }
        );
      }
      data.embeddingCredentialRef = await encryptEmbeddingProviderCredential(resolvedEmbeddingProvider, embeddingApiKey);
    }

    const updated = await db.businessConfig.update({
      where: { businessId: ctx.businessId },
      data,
    });

    // The embedding provider/credential may have changed (an embedding key,
    // or a generation key/provider that embeddings fall back to — §22.2):
    // queue every entry whose stored embedding is now missing or stale. The
    // shared scan skips entries already current; a failure never fails the save.
    const embeddingConfigTouched = Boolean(aiApiKey || embeddingApiKey || rest.aiProvider || rest.embeddingProvider);
    if (embeddingConfigTouched) {
      await reindexStaleEntries(ctx).catch((error) =>
        logger.error("Failed to enqueue knowledge reindex after AI settings change", undefined, {
          businessId: ctx.businessId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }

    return NextResponse.json(toView(updated));
  } catch (error) {
    logger.error("Failed to update AI settings:", error);
    return toErrorResponse(error);
  }
}
