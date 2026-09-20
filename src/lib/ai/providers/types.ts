/**
 * PLAN.md §46.4 (Phase 4) / §21.1, §21.5 — the `AIProvider`/`EmbeddingProvider`
 * contracts, finalized against the first real, non-OpenAI implementation
 * (`AnthropicProvider`, `ai/providers/anthropic.ts`) per §46.3's own
 * deferral ("Phase 3 fixes only this contract's module location ... the
 * exact method signatures ... Phase 4 finalizes them").
 *
 * One deliberate refinement over §21.1's illustrative sketch:
 * `AIProviderRegistry.get()`/`EmbeddingProviderRegistry.get()` (registry.ts,
 * embedding-registry.ts) take the resolved credential as an explicit
 * parameter and construct a fresh, credential-bound provider instance per
 * call, rather than each registered `AIProvider` being one long-lived
 * singleton per name — necessary because two businesses selecting the same
 * provider name ("openai") almost always hold different API keys
 * (§10.3/§16.5's explicit-secret-resolution discipline: a credential is
 * never implicit ambient state). This does not change the `AIProvider`/
 * `EmbeddingProvider` interfaces themselves, only how a concrete instance
 * satisfying them gets constructed.
 */

export interface AIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCallRequest[];
}

/** A provider-agnostic tool call, translated to/from each SDK's native shape by its own provider. */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CompletionRequest {
  messages: AIMessage[];
  tools?: ToolDefinition[];
  maxTokens: number;
  temperature: number;
  model: string;
}

export interface CompletionResult {
  type: "text" | "tool_calls";
  text?: string;
  /** Each carries the provider's own tool-call id — §24.4's future idempotency key. */
  toolCalls?: ToolCallRequest[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export type AIProviderErrorCode =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "invalid_request"
  | "provider_unavailable"
  | "unknown";

export class AIProviderError extends Error {
  constructor(
    public code: AIProviderErrorCode,
    message: string,
    public retryable: boolean
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}

export interface AIProvider {
  readonly name: string;
  readonly capabilities: { toolCalling: boolean; streaming: boolean; multimodal: boolean };
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export interface EmbeddingResult {
  vector: number[];
  model: string;
  usage: { totalTokens: number };
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<EmbeddingResult>;
}
