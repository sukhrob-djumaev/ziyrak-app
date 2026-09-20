import { z } from "zod";

/**
 * PLAN.md §46.4/§10.3(a) — typed, per-provider credential schemas for the
 * AI/embedding provider boundary, the same discipline `secrets/credential-
 * schemas.ts` applies to channel credentials: a decrypted `BusinessConfig.
 * aiCredentialRef`/`embeddingCredentialRef` payload is validated against one
 * of these before any provider is allowed to use it, so a malformed or
 * tampered payload fails closed with a clear error instead of an
 * `undefined` deep inside a provider adapter.
 *
 * Kept separate from `secrets/credential-schemas.ts` (channel credentials,
 * keyed by `ChannelConnection.type`) since these are keyed by
 * `BusinessConfig.aiProvider`/`embeddingProvider`, a different, unrelated
 * namespace of provider names.
 */

export const OpenAIProviderCredentialSchema = z.object({
  provider: z.literal("openai"),
  apiKey: z.string().min(1),
});

export const AnthropicProviderCredentialSchema = z.object({
  provider: z.literal("anthropic"),
  apiKey: z.string().min(1),
});

export const AIProviderCredentialSchema = z.discriminatedUnion("provider", [
  OpenAIProviderCredentialSchema,
  AnthropicProviderCredentialSchema,
]);

export type AIProviderCredential = z.infer<typeof AIProviderCredentialSchema>;

export const OpenAIEmbeddingCredentialSchema = z.object({
  provider: z.literal("openai"),
  apiKey: z.string().min(1),
});

/** A discriminated union of one today (§21.5 — a second embedding provider is not built in this plan). */
export const EmbeddingProviderCredentialSchema = z.discriminatedUnion("provider", [
  OpenAIEmbeddingCredentialSchema,
]);

export type EmbeddingProviderCredential = z.infer<typeof EmbeddingProviderCredentialSchema>;
