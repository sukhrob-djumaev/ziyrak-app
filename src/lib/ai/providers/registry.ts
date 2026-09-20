import type { AIProvider } from "./types";
import { AIProviderError } from "./types";
import { OpenAIProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { OllamaProvider } from "./ollama";

/**
 * PLAN.md §46.4/§21.2 — dispatches `BusinessConfig.aiProvider` to a real
 * `AIProvider` implementation, replacing `engine.ts`'s hardcoded `new
 * OpenAI(...)` (§2.3's exact bug: `config.provider` was loaded but never
 * read). A factory, not a map of live singletons, since each business
 * resolves its own credential (§10.3/§16.5) — two businesses both selecting
 * `"openai"` almost always hold different API keys.
 */
type AIProviderFactory = (credential: { apiKey: string }) => AIProvider;

export class AIProviderRegistry {
  private readonly factories = new Map<string, AIProviderFactory>();

  register(name: string, factory: AIProviderFactory): void {
    this.factories.set(name, factory);
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  get(name: string, credential: { apiKey: string }): AIProvider {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new AIProviderError("invalid_request", `Unknown AI provider "${name}".`, false);
    }
    return factory(credential);
  }
}

export const aiProviderRegistry = new AIProviderRegistry();
aiProviderRegistry.register("openai", ({ apiKey }) => new OpenAIProvider(apiKey));
aiProviderRegistry.register("anthropic", ({ apiKey }) => new AnthropicProvider(apiKey));
aiProviderRegistry.register("ollama", () => new OllamaProvider());
