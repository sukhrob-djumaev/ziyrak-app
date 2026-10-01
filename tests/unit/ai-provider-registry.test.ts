import { describe, it, expect, vi, beforeEach } from "vitest";

const mockOpenAICreateFn = vi.fn();
vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  class MockOpenAI {
    chat = { completions: { create: mockOpenAICreateFn } };
  }
  return { ...actual, default: MockOpenAI };
});

const mockAnthropicCreateFn = vi.fn();
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class MockAnthropic {
    messages = { create: mockAnthropicCreateFn };
  }
  return { ...actual, default: MockAnthropic };
});

import { aiProviderRegistry } from "@/lib/ai/providers/registry";
import { embeddingProviderRegistry } from "@/lib/ai/providers/embedding-registry";
import { AIProviderError } from "@/lib/ai/providers/types";

describe("AIProviderRegistry (§46.4/§21.2) — dispatch is real, not hardcoded", () => {
  beforeEach(() => {
    mockOpenAICreateFn.mockReset();
    mockAnthropicCreateFn.mockReset();
  });

  it("selecting \"openai\" calls the OpenAI SDK and never Anthropic's", async () => {
    mockOpenAICreateFn.mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: "from openai" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const provider = aiProviderRegistry.get("openai", { apiKey: "sk-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
      temperature: 0.5,
      model: "gpt-4o-mini",
    });

    expect(result.text).toBe("from openai");
    expect(mockOpenAICreateFn).toHaveBeenCalledTimes(1);
    expect(mockAnthropicCreateFn).not.toHaveBeenCalled();
  });

  it("selecting \"anthropic\" calls the Anthropic SDK and never OpenAI's — proving provider selection actually changes which implementation runs", async () => {
    mockAnthropicCreateFn.mockResolvedValue({
      content: [{ type: "text", text: "from anthropic" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const provider = aiProviderRegistry.get("anthropic", { apiKey: "sk-ant-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
      temperature: 0.5,
      model: "claude-sonnet-5-5",
    });

    expect(result.text).toBe("from anthropic");
    expect(mockAnthropicCreateFn).toHaveBeenCalledTimes(1);
    expect(mockOpenAICreateFn).not.toHaveBeenCalled();
  });

  it("selecting \"ollama\" fails clearly instead of silently routing to OpenAI (§2.3's original bug)", async () => {
    const provider = aiProviderRegistry.get("ollama", { apiKey: "" });
    await expect(
      provider.complete({ messages: [], maxTokens: 10, temperature: 0.5, model: "llama3" })
    ).rejects.toBeInstanceOf(AIProviderError);
    expect(mockOpenAICreateFn).not.toHaveBeenCalled();
    expect(mockAnthropicCreateFn).not.toHaveBeenCalled();
  });

  it("throws a clear error for an unknown provider name rather than silently defaulting to any one provider", () => {
    expect(() => aiProviderRegistry.get("not-a-real-provider", { apiKey: "x" })).toThrow(AIProviderError);
  });

  it("two businesses selecting the same provider each get their own credential-bound instance", async () => {
    mockOpenAICreateFn.mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const providerA = aiProviderRegistry.get("openai", { apiKey: "sk-business-a" });
    const providerB = aiProviderRegistry.get("openai", { apiKey: "sk-business-b" });
    expect(providerA).not.toBe(providerB);
  });
});

describe("EmbeddingProviderRegistry (§46.4/§21.5)", () => {
  it("dispatches \"openai\" to the OpenAI embedding provider", () => {
    const provider = embeddingProviderRegistry.get("openai", { apiKey: "sk-test" });
    expect(provider.name).toBe("openai");
  });

  it("throws a clear error for an unregistered embedding provider", () => {
    expect(() => embeddingProviderRegistry.get("not-a-real-provider", { apiKey: "x" })).toThrow(AIProviderError);
  });
});
