import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma/raw-client";
import type { TenantContext } from "@/lib/tenancy/context";
import { TEST_DEFAULT_BUSINESS_ID } from "../setup";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

const defaultCtx: TenantContext = {
  businessId: TEST_DEFAULT_BUSINESS_ID,
  role: "owner",
  actor: { kind: "user", userId: "test-user" },
  dataConnection: "shared-default",
};

const otherBusinessCtx: TenantContext = {
  businessId: "other-business-id",
  role: "owner",
  actor: { kind: "user", userId: "other-user" },
  dataConnection: "shared-default",
};

describe("resolveAIConfig/resolveEmbeddingConfig (§46.4/§10.4) — precedence", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPrisma.businessConfig.findUnique.mockReset();
    mockPrisma.settings.findUnique.mockReset();
  });

  it("uses BusinessConfig's own credential when set, for any business", async () => {
    const { encryptAIProviderCredential, resolveAIConfig } = await import("@/lib/ai/config");
    const ref = await encryptAIProviderCredential("anthropic", "sk-ant-own-key");

    mockPrisma.businessConfig.findUnique.mockResolvedValue({
      businessId: otherBusinessCtx.businessId,
      aiProvider: "anthropic",
      aiModel: "claude-sonnet-4-20250514",
      embeddingProvider: null,
      maxTokens: 1500,
      temperature: 0.4,
      aiCredentialRef: ref,
      embeddingCredentialRef: null,
    });

    const config = await resolveAIConfig(otherBusinessCtx);
    expect(config).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      maxTokens: 1500,
      temperature: 0.4,
      apiKey: "sk-ant-own-key",
    });
    expect(mockPrisma.settings.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to legacy Settings.aiApiKey for the Default Business only, when it has no BusinessConfig of its own yet", async () => {
    const { resolveAIConfig } = await import("@/lib/ai/config");

    mockPrisma.businessConfig.findUnique.mockResolvedValue({
      businessId: TEST_DEFAULT_BUSINESS_ID,
      aiProvider: null,
      aiModel: null,
      embeddingProvider: null,
      maxTokens: null,
      temperature: null,
      aiCredentialRef: null,
      embeddingCredentialRef: null,
    });
    mockPrisma.settings.findUnique.mockResolvedValue({
      id: "default",
      aiProvider: "openai",
      aiModel: "gpt-4o-mini",
      aiApiKey: "sk-legacy-key",
      maxTokens: 2048,
      temperature: 0.7,
    });

    const config = await resolveAIConfig(defaultCtx);
    expect(config).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
      maxTokens: 2048,
      temperature: 0.7,
      apiKey: "sk-legacy-key",
    });
  });

  it("normalizes the legacy \"claude\" provider value to \"anthropic\"", async () => {
    const { resolveAIConfig } = await import("@/lib/ai/config");

    mockPrisma.businessConfig.findUnique.mockResolvedValue({ businessId: TEST_DEFAULT_BUSINESS_ID });
    mockPrisma.settings.findUnique.mockResolvedValue({
      id: "default",
      aiProvider: "claude",
      aiModel: "claude-3-opus-20240229",
      aiApiKey: "sk-legacy-claude-key",
      maxTokens: 2048,
      temperature: 0.7,
    });

    const config = await resolveAIConfig(defaultCtx);
    expect(config.provider).toBe("anthropic");
  });

  it("never falls back to legacy Settings for a non-Default business", async () => {
    const { resolveAIConfig } = await import("@/lib/ai/config");

    mockPrisma.businessConfig.findUnique.mockResolvedValue({ businessId: otherBusinessCtx.businessId });
    mockPrisma.settings.findUnique.mockResolvedValue({
      id: "default",
      aiProvider: "openai",
      aiModel: "gpt-4o-mini",
      aiApiKey: "sk-legacy-key",
      maxTokens: 2048,
      temperature: 0.7,
    });

    const config = await resolveAIConfig(otherBusinessCtx);
    expect(config.apiKey).toBeNull();
    expect(mockPrisma.settings.findUnique).not.toHaveBeenCalled();
  });

  it("stops consulting the legacy row once the Default Business has set its own aiProvider, even without a credential yet", async () => {
    const { resolveAIConfig } = await import("@/lib/ai/config");

    mockPrisma.businessConfig.findUnique.mockResolvedValue({
      businessId: TEST_DEFAULT_BUSINESS_ID,
      aiProvider: "anthropic",
      aiCredentialRef: null,
    });
    mockPrisma.settings.findUnique.mockResolvedValue({
      id: "default",
      aiProvider: "openai",
      aiModel: "gpt-4o-mini",
      aiApiKey: "sk-legacy-key",
      maxTokens: 2048,
      temperature: 0.7,
    });

    const config = await resolveAIConfig(defaultCtx);
    expect(config.apiKey).toBeNull();
    expect(config.provider).toBe("anthropic");
  });

  it("is not configured (apiKey: null) for a business with no credential and no legacy fallback available", async () => {
    const { resolveAIConfig } = await import("@/lib/ai/config");

    mockPrisma.businessConfig.findUnique.mockResolvedValue(null);
    mockPrisma.settings.findUnique.mockResolvedValue(null);

    const config = await resolveAIConfig(otherBusinessCtx);
    expect(config.apiKey).toBeNull();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o-mini");
  });

  it("returns null (fails closed) rather than a usable key when the stored credential's provider no longer matches the selected provider", async () => {
    const { encryptAIProviderCredential, resolveAIConfig } = await import("@/lib/ai/config");
    const ref = await encryptAIProviderCredential("openai", "sk-openai-key");

    mockPrisma.businessConfig.findUnique.mockResolvedValue({
      businessId: otherBusinessCtx.businessId,
      aiProvider: "anthropic", // switched provider without re-entering a key
      aiCredentialRef: ref,
    });

    const config = await resolveAIConfig(otherBusinessCtx);
    expect(config.apiKey).toBeNull();
    expect(config.provider).toBe("anthropic");
  });

  it("embedding config reuses the generation credential when the embedding provider matches and no separate key was set", async () => {
    const { encryptAIProviderCredential, resolveEmbeddingConfig } = await import("@/lib/ai/config");
    const ref = await encryptAIProviderCredential("openai", "sk-shared-key");

    mockPrisma.businessConfig.findUnique.mockResolvedValue({
      businessId: otherBusinessCtx.businessId,
      aiProvider: "openai",
      aiCredentialRef: ref,
      embeddingProvider: null,
      embeddingCredentialRef: null,
    });

    const config = await resolveEmbeddingConfig(otherBusinessCtx);
    expect(config).toEqual({ provider: "openai", apiKey: "sk-shared-key" });
  });

  it("embedding config uses its own dedicated credential over the generation one when both are set", async () => {
    const { encryptAIProviderCredential, encryptEmbeddingProviderCredential, resolveEmbeddingConfig } = await import(
      "@/lib/ai/config"
    );
    const aiRef = await encryptAIProviderCredential("openai", "sk-generation-key");
    const embeddingRef = await encryptEmbeddingProviderCredential("openai", "sk-embedding-key");

    mockPrisma.businessConfig.findUnique.mockResolvedValue({
      businessId: otherBusinessCtx.businessId,
      aiProvider: "openai",
      aiCredentialRef: aiRef,
      embeddingProvider: "openai",
      embeddingCredentialRef: embeddingRef,
    });

    const config = await resolveEmbeddingConfig(otherBusinessCtx);
    expect(config).toEqual({ provider: "openai", apiKey: "sk-embedding-key" });
  });
});
