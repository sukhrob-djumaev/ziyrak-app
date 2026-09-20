import Anthropic, { APIError, APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  Tool as AnthropicTool,
} from "@anthropic-ai/sdk/resources/messages";
import type { AIMessage, AIProvider, CompletionRequest, CompletionResult, ToolCallRequest } from "./types";
import { AIProviderError } from "./types";

/**
 * PLAN.md §46.4/§21.2 — the second real `AIProvider` implementation, built
 * specifically to prove the abstraction isn't a single-implementation
 * interface built on faith (Principle 2, §4). Anthropic's Messages API has a
 * meaningfully different shape from OpenAI's Chat Completions API (a
 * top-level `system` param instead of a `system` role; tool results folded
 * into a `user` turn's content blocks instead of a `tool` role; strict
 * user/assistant turn alternation) — `toAnthropicMessages()` below is what
 * translates the provider-agnostic `AIMessage[]` into that shape.
 */
export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  readonly capabilities = { toolCalling: true, streaming: false, multimodal: false };
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const tools: AnthropicTool[] | undefined = request.tools?.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as AnthropicTool["input_schema"],
    }));

    let response;
    try {
      response = await this.client.messages.create({
        model: request.model,
        system: system || undefined,
        messages,
        tools,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
      });
    } catch (error) {
      throw toAIProviderError(error);
    }

    const usage = {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    };

    const textParts: string[] = [];
    const toolCalls: ToolCallRequest[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
      }
    }

    if (response.stop_reason === "tool_use" && toolCalls.length > 0) {
      return { type: "tool_calls", text: textParts.join("\n") || undefined, toolCalls, usage };
    }

    return { type: "text", text: textParts.join("\n"), usage };
  }
}

/**
 * Translates the provider-agnostic message history into Anthropic's shape.
 * Consecutive `tool` messages (one per tool call from the same assistant
 * turn) are folded into a single `user` turn carrying multiple
 * `tool_result` blocks, since Anthropic requires strict user/assistant
 * alternation — a run of individual `tool`-role messages, one per call,
 * would otherwise violate that.
 */
export function toAnthropicMessages(messages: AIMessage[]): { system: string; messages: MessageParam[] } {
  let system = "";
  const result: MessageParam[] = [];
  let pendingToolResults: ToolResultBlockParam[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      result.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const msg of messages) {
    if (msg.role === "system") {
      system += (system ? "\n\n" : "") + msg.content;
      continue;
    }

    if (msg.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: msg.tool_call_id ?? "",
        content: msg.content,
      });
      continue;
    }

    flushToolResults();

    if (msg.role === "assistant" && msg.tool_calls?.length) {
      const content: ContentBlockParam[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const tc of msg.tool_calls) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: safeParseArguments(tc.arguments) });
      }
      result.push({ role: "assistant", content });
      continue;
    }

    result.push({ role: msg.role, content: msg.content });
  }

  flushToolResults();
  return { system, messages: result };
}

function safeParseArguments(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function toAIProviderError(error: unknown): AIProviderError {
  if (error instanceof APIConnectionTimeoutError) {
    return new AIProviderError("timeout", error.message, true);
  }
  if (error instanceof APIError) {
    const message = error.message || "Anthropic request failed";
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
  const message = error instanceof Error ? error.message : "Unknown Anthropic provider error";
  return new AIProviderError("unknown", message, false);
}
