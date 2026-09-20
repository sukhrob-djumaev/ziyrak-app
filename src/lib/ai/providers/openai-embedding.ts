import OpenAI, { APIError, APIConnectionTimeoutError } from "openai";
import type { EmbeddingProvider, EmbeddingResult } from "./types";
import { AIProviderError } from "./types";

const MODEL = "text-embedding-3-small";
const DIMENSIONS = 1536;
const MAX_INPUT_CHARS = 8000;

/**
 * PLAN.md §46.4/§21.5/§22.2 — wraps exactly the same `text-embedding-3-
 * small` call `knowledge/semantic-search.ts:30-48` made via a direct
 * `fetch("https://api.openai.com/v1/embeddings")` before this phase, now
 * behind the `EmbeddingProvider` contract and the official SDK (consistent
 * with `OpenAIProvider`'s generation counterpart) instead of a hand-rolled
 * fetch. The only implementation built for this plan (§21.5 — a second
 * embedding provider is not justified by any concrete near-term
 * requirement).
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimensions = DIMENSIONS;
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(text: string): Promise<EmbeddingResult> {
    let response;
    try {
      response = await this.client.embeddings.create({
        model: MODEL,
        input: text.substring(0, MAX_INPUT_CHARS),
      });
    } catch (error) {
      throw toAIProviderError(error);
    }

    const vector = response.data[0]?.embedding ?? [];
    return {
      vector,
      model: MODEL,
      usage: { totalTokens: response.usage?.total_tokens ?? 0 },
    };
  }
}

function toAIProviderError(error: unknown): AIProviderError {
  if (error instanceof APIConnectionTimeoutError) {
    return new AIProviderError("timeout", error.message, true);
  }
  if (error instanceof APIError) {
    const message = error.message || "OpenAI embedding request failed";
    switch (error.status) {
      case 401:
      case 403:
        return new AIProviderError("auth", message, false);
      case 429:
        return new AIProviderError("rate_limit", message, true);
      case 400:
      case 404:
      case 422:
        return new AIProviderError("invalid_request", message, false);
      default:
        if (typeof error.status === "number" && error.status >= 500) {
          return new AIProviderError("provider_unavailable", message, true);
        }
        return new AIProviderError("unknown", message, false);
    }
  }
  const message = error instanceof Error ? error.message : "Unknown OpenAI embedding provider error";
  return new AIProviderError("unknown", message, false);
}
