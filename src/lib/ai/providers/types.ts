/**
 * PLAN.md §46.3 (Phase 3) / §21.1, §21.5 — module-boundary sketch, not a
 * frozen contract. Per review concern 22 (§46.3's own rationale), Phase 3
 * fixes only this contract's module location (`ai/providers/`) and its
 * allowed dependency direction (application/domain modules may depend on
 * this interface; they must never import a concrete provider SDK, e.g.
 * `openai`, directly — enforced by eslint.config.mjs's `ai/` boundary
 * rule). The exact method signatures below are illustrative — Phase 4
 * (§46.4) finalizes them against the first real, non-OpenAI implementation
 * (`AnthropicProvider`), not against this sketch alone.
 *
 * No implementation exists yet. `ai/engine.ts` still calls the OpenAI SDK
 * directly (§46.3's own task list: "still calling ... hardcoded OpenAI at
 * this point — Phase 4 is what fixes those").
 */

export interface AIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

export interface CompletionRequest {
  messages: AIMessage[];
  maxTokens: number;
  temperature: number;
  model: string;
}

export interface CompletionResult {
  type: "text" | "tool_calls";
  text?: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** Illustrative only (§21.1) — finalized in Phase 4 against a real second provider. */
export interface AIProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export interface EmbeddingResult {
  vector: number[];
  model: string;
  usage: { totalTokens: number };
}

/** Illustrative only (§21.5) — finalized in Phase 4 alongside KnowledgeRetriever (§22.1). */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<EmbeddingResult>;
}
