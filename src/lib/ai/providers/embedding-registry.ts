import type { EmbeddingProvider } from "./types";
import { AIProviderError } from "./types";
import { OpenAIEmbeddingProvider } from "./openai-embedding";

/**
 * PLAN.md §46.4/§21.5 — the `EmbeddingProvider` counterpart to
 * `AIProviderRegistry`, kept as a genuinely separate registry (not a case in
 * the same one) because generation and embedding are independently
 * selectable capabilities with independent data-exposure surfaces (§21.5's
 * own reasoning) — a business could one day route generation through a
 * private endpoint while still (or instead) using OpenAI for embeddings, or
 * vice versa.
 */
type EmbeddingProviderFactory = (credential: { apiKey: string }) => EmbeddingProvider;

export class EmbeddingProviderRegistry {
  private readonly factories = new Map<string, EmbeddingProviderFactory>();

  register(name: string, factory: EmbeddingProviderFactory): void {
    this.factories.set(name, factory);
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  get(name: string, credential: { apiKey: string }): EmbeddingProvider {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new AIProviderError("invalid_request", `Unknown embedding provider "${name}".`, false);
    }
    return factory(credential);
  }
}

export const embeddingProviderRegistry = new EmbeddingProviderRegistry();
embeddingProviderRegistry.register("openai", ({ apiKey }) => new OpenAIEmbeddingProvider(apiKey));
