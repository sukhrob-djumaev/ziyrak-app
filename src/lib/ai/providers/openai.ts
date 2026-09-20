import OpenAI, { APIError, APIConnectionTimeoutError } from "openai";
import type {
  AIProvider,
  CompletionRequest,
  CompletionResult,
  ToolCallRequest,
} from "./types";
import { AIProviderError } from "./types";

/**
 * PLAN.md §46.4/§21.2 — a thin wrapper around exactly the same
 * `openai.chat.completions.create(...)` call `engine.ts:213-219` made
 * directly before this phase (behavior-preserving for the one provider that
 * already worked correctly), now behind the `AIProvider` contract so the
 * rest of `ai/` never imports the `openai` SDK directly (§5.7, enforced by
 * `eslint.config.mjs`'s `ai/` boundary rule).
 */
export class OpenAIProvider implements AIProvider {
  readonly name = "openai";
  readonly capabilities = { toolCalling: true, streaming: false, multimodal: false };
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    let response;
    try {
      response = await this.client.chat.completions.create({
        model: request.model,
        messages: request.messages as OpenAI.ChatCompletionMessageParam[],
        tools: request.tools as OpenAI.ChatCompletionTool[] | undefined,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
      });
    } catch (error) {
      throw toAIProviderError(error);
    }

    const choice = response.choices[0];
    const usage = {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    };

    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
      // owlyTools (tools/tools.ts) only ever defines function-type tools, so
      // OpenAI only ever returns the "function" variant of its tool_calls
      // union (the other, "custom", is a freeform-text tool this codebase
      // never registers) — filtered rather than assumed, since the SDK's
      // own type is a union.
      const toolCalls: ToolCallRequest[] = choice.message.tool_calls
        .filter((tc): tc is OpenAI.ChatCompletionMessageFunctionToolCall => tc.type === "function")
        .map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }));
      return { type: "tool_calls", toolCalls, usage };
    }

    return { type: "text", text: choice.message.content ?? "", usage };
  }
}

function toAIProviderError(error: unknown): AIProviderError {
  if (error instanceof APIConnectionTimeoutError) {
    return new AIProviderError("timeout", error.message, true);
  }
  if (error instanceof APIError) {
    const message = error.message || "OpenAI request failed";
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
  const message = error instanceof Error ? error.message : "Unknown OpenAI provider error";
  return new AIProviderError("unknown", message, false);
}
