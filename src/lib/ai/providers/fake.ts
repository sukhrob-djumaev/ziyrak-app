import type { AIProvider, CompletionRequest, CompletionResult, EmbeddingProvider, EmbeddingResult } from "./types";

/**
 * PLAN.md §21.4 — the standard `AIProvider` test double: deterministic
 * canned responses, returned in sequence, so a test can simulate a tool-call
 * round trip (first `complete()` call returns `tool_calls`, the next returns
 * `text`) without any real network call. Records every request it received
 * so a test can assert what `AIOrchestrator`/`chat()` actually sent it (e.g.
 * that a knowledge-bounded prompt, not a full-KB dump, was constructed).
 */
export class FakeAIProvider implements AIProvider {
  readonly name = "fake";
  readonly capabilities = { toolCalling: true, streaming: false, multimodal: false };
  readonly requests: CompletionRequest[] = [];
  private callIndex = 0;

  constructor(private readonly responses: CompletionResult[] = []) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);
    const result =
      this.responses[this.callIndex] ?? this.responses[this.responses.length - 1] ?? defaultTextResult();
    this.callIndex++;
    return result;
  }
}

function defaultTextResult(): CompletionResult {
  return {
    type: "text",
    text: "This is a fake AI response.",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
}

/** The `EmbeddingProvider` equivalent (§21.5's own fake, named alongside §21.4's). */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = "fake";
  readonly model = "fake-embedding";
  readonly dimensions: number;
  readonly requests: string[] = [];

  constructor(dimensions = 8) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    this.requests.push(text);
    // Deterministic, content-derived vector so similarity scoring behaves
    // meaningfully in tests without a real embeddings API call.
    const vector = Array.from({ length: this.dimensions }, (_, i) => hashCharAt(text, i));
    return { vector, model: "fake-embedding", usage: { totalTokens: Math.ceil(text.length / 4) } };
  }
}

function hashCharAt(text: string, index: number): number {
  let hash = index + 1;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) % 1000;
  }
  return hash / 1000;
}
