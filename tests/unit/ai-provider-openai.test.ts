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

  it("echoes a prior assistant tool call back in OpenAI's wire shape (type: \"function\" + nested function)", async () => {
    // Found by the 2026-10-01 real-OpenAI acceptance run: the follow-up completion after a tool call was
    // rejected with `400 Missing required parameter: 'messages[2].tool_calls[0].type'`, because the
    // provider-agnostic flat `{id, name, arguments}` was cast, not translated, into OpenAI's message params.
    mockCreateFn.mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: "Your ticket is open." } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    await new OpenAIProvider("sk-test").complete({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "please open a ticket" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call-1", name: "create_ticket", arguments: '{"title":"t"}' }],
          providerContent: { provider: "anthropic", content: [{ type: "thinking" }] },
        },
        { role: "tool", content: '{"success":true}', tool_call_id: "call-1" },
      ],
      maxTokens: 100,
      temperature: 0.3,
      model: "gpt-4o-mini",
    });

    const sent = mockCreateFn.mock.calls[0][0].messages;
    expect(sent[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-1", type: "function", function: { name: "create_ticket", arguments: '{"title":"t"}' } }],
    });
    expect(sent[3]).toEqual({ role: "tool", content: '{"success":true}', tool_call_id: "call-1" });
    expect(sent[0]).toEqual({ role: "system", content: "sys" });
    expect(sent[1]).toEqual({ role: "user", content: "please open a ticket" });
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
