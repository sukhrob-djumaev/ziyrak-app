import type { AIProvider, CompletionResult } from "./types";
import { AIProviderError } from "./types";

/**
 * PLAN.md §46.4/§21.2 — an honest stub, not a silent mis-route. Today's
 * `Settings.aiProvider` could be set to `"ollama"` and every generation call
 * would silently still hit OpenAI (§2.3's finding — `callAI()` never read
 * `config.provider`). Registering this in `AIProviderRegistry` means
 * selecting "Ollama" now fails clearly and immediately instead of silently
 * misrouting or crashing deep inside an adapter that doesn't exist. A real
 * implementation is out of scope for this plan (§46.4's own "Explicitly
 * deferred" list) — it targets a self-hosted/local-LLM use case that is not
 * part of the MVP commercial product.
 */
export class OllamaProvider implements AIProvider {
  readonly name = "ollama";
  readonly capabilities = { toolCalling: false, streaming: false, multimodal: false };

  async complete(): Promise<CompletionResult> {
    throw new AIProviderError(
      "provider_unavailable",
      "Ollama support is not yet implemented. Select OpenAI or Anthropic for now.",
      false
    );
  }
}
