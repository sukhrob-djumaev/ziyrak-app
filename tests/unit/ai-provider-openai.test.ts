import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateFn = vi.fn();

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  class MockOpenAI {
    chat = { completions: { create: mockCreateFn } };
  }
  return { ...actual, default: MockOpenAI };
});

import { OpenAIProvider } from "@/lib/ai/providers/openai";
import { AIProviderError } from "@/lib/ai/providers/types";
import {
  assertProviderIdentity,
  assertTextCompletionContract,
  assertToolCallCompletionContract,
} from "../helpers/ai-provider-contract";
import { APIError } from "openai";

describe("OpenAIProvider (§46.4/§21.2) satisfies the AIProvider contract", () => {
  beforeEach(() => {
    mockCreateFn.mockReset();
  });

  it("has a well-formed name/capabilities", () => {
    assertProviderIdentity(new OpenAIProvider("sk-test"), "openai");
  });

  it("wraps a plain text completion", async () => {
    mockCreateFn.mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: "Hello there!" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    await assertTextCompletionContract(new OpenAIProvider("sk-test"));
  });

  it("wraps a tool-call completion", async () => {
    mockCreateFn.mockResolvedValue({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "",
            tool_calls: [
              { id: "call-1", type: "function", function: { name: "get_order_status", arguments: '{"orderId":"123"}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
    await assertToolCallCompletionContract(new OpenAIProvider("sk-test"), "get_order_status");
  });

  it("calls the SDK with the exact model/messages/tools/maxTokens/temperature from the request", async () => {
    mockCreateFn.mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    await new OpenAIProvider("sk-test").complete({
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      maxTokens: 500,
      temperature: 0.3,
      model: "gpt-4o-mini",
    });

    expect(mockCreateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini",
        max_tokens: 500,
        temperature: 0.3,
        messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      })
    );
  });

  it("maps a 401 to a non-retryable auth AIProviderError", async () => {
    mockCreateFn.mockRejectedValue(new APIError(401, {}, "Invalid API key", new Headers()));

    await expect(new OpenAIProvider("bad-key").complete({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
      temperature: 0.5,
      model: "gpt-4o-mini",
    })).rejects.toMatchObject({ code: "auth", retryable: false } satisfies Partial<AIProviderError>);
  });

  it("maps a 429 to a retryable rate_limit AIProviderError", async () => {
    mockCreateFn.mockRejectedValue(new APIError(429, {}, "Rate limited", new Headers()));

    await expect(new OpenAIProvider("sk-test").complete({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
      temperature: 0.5,
      model: "gpt-4o-mini",
    })).rejects.toMatchObject({ code: "rate_limit", retryable: true });
  });

  it("maps a 500 to a retryable provider_unavailable AIProviderError", async () => {
    mockCreateFn.mockRejectedValue(new APIError(500, {}, "Server error", new Headers()));

    await expect(new OpenAIProvider("sk-test").complete({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
      temperature: 0.5,
      model: "gpt-4o-mini",
    })).rejects.toMatchObject({ code: "provider_unavailable", retryable: true });
  });
});
