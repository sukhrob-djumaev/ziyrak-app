import { expect } from "vitest";
import type { AIProvider, CompletionRequest } from "@/lib/ai/providers/types";

/**
 * PLAN.md §34.1 — "one shared contract-test suite per interface, run
 * against every implementation." Each `AIProvider` implementation's own
 * test file configures its underlying SDK mock to return a canonical
 * shape, then asserts through these shared checks — so the same contract is
 * verified identically for `OpenAIProvider`, `AnthropicProvider`, and
 * `FakeAIProvider` (§21.4 — "the fake must also pass the same contract
 * suite to prove it's a faithful double").
 */

const TEXT_REQUEST: CompletionRequest = {
  messages: [{ role: "user", content: "Hello" }],
  maxTokens: 100,
  temperature: 0.7,
  model: "test-model",
};

export async function assertTextCompletionContract(provider: AIProvider, model = TEXT_REQUEST.model): Promise<void> {
  const result = await provider.complete({ ...TEXT_REQUEST, model });
  expect(result.type).toBe("text");
  expect(typeof result.text).toBe("string");
  expect(result.usage.promptTokens).toBeGreaterThanOrEqual(0);
  expect(result.usage.completionTokens).toBeGreaterThanOrEqual(0);
  expect(result.usage.totalTokens).toBe(result.usage.promptTokens + result.usage.completionTokens);
}

export async function assertToolCallCompletionContract(
  provider: AIProvider,
  toolName: string,
  model = "test-model"
): Promise<void> {
  const request: CompletionRequest = {
    messages: [{ role: "user", content: "What's my order status?" }],
    tools: [
      {
        type: "function",
        function: {
          name: toolName,
          description: "Look up an order",
          parameters: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
        },
      },
    ],
    maxTokens: 100,
    temperature: 0.7,
    model,
  };

  const result = await provider.complete(request);
  expect(result.type).toBe("tool_calls");
  expect(result.toolCalls?.length).toBeGreaterThan(0);
  for (const call of result.toolCalls ?? []) {
    expect(typeof call.id).toBe("string");
    expect(call.id.length).toBeGreaterThan(0);
    expect(typeof call.name).toBe("string");
    expect(typeof call.arguments).toBe("string");
    expect(() => JSON.parse(call.arguments)).not.toThrow();
  }
}

export function assertProviderIdentity(provider: AIProvider, expectedName: string): void {
  expect(provider.name).toBe(expectedName);
  expect(typeof provider.capabilities.toolCalling).toBe("boolean");
  expect(typeof provider.capabilities.streaming).toBe("boolean");
  expect(typeof provider.capabilities.multimodal).toBe("boolean");
}
