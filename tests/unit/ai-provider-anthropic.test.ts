import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateFn = vi.fn();

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class MockAnthropic {
    messages = { create: mockCreateFn };
  }
  return { ...actual, default: MockAnthropic };
});

import { AnthropicProvider, toAnthropicMessages } from "@/lib/ai/providers/anthropic";
import { AIProviderError } from "@/lib/ai/providers/types";
import {
  assertProviderIdentity,
  assertTextCompletionContract,
  assertToolCallCompletionContract,
} from "../helpers/ai-provider-contract";
import { APIError } from "@anthropic-ai/sdk";

describe("AnthropicProvider (§46.4/§21.2) satisfies the AIProvider contract", () => {
  beforeEach(() => {
    mockCreateFn.mockReset();
  });

  it("has a well-formed name/capabilities", () => {
    assertProviderIdentity(new AnthropicProvider("sk-ant-test"), "anthropic");
  });

  it("wraps a plain text completion", async () => {
    mockCreateFn.mockResolvedValue({
      content: [{ type: "text", text: "Hello there!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    await assertTextCompletionContract(new AnthropicProvider("sk-ant-test"), "claude-sonnet-5-5");
  });

  it("wraps a tool-call completion", async () => {
    mockCreateFn.mockResolvedValue({
      content: [{ type: "tool_use", id: "toolu_1", name: "get_order_status", input: { orderId: "123" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 10 },
    });
    await assertToolCallCompletionContract(new AnthropicProvider("sk-ant-test"), "get_order_status", "claude-sonnet-5-5");
  });

  it("maps the system-role message to the top-level system param, not a message", async () => {
    mockCreateFn.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await new AnthropicProvider("sk-ant-test").complete({
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "hi" },
      ],
      maxTokens: 100,
      temperature: 0.5,
      model: "claude-sonnet-5-5",
    });

    expect(mockCreateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: "hi" }],
      })
    );
  });

  it("maps a 401 to a non-retryable auth AIProviderError", async () => {
    mockCreateFn.mockRejectedValue(new APIError(401, {}, "Invalid API key", new Headers()));

    await expect(new AnthropicProvider("bad-key").complete({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
      temperature: 0.5,
      model: "claude-sonnet-5-5",
    })).rejects.toMatchObject({ code: "auth", retryable: false } satisfies Partial<AIProviderError>);
  });

  it("maps a 429 to a retryable rate_limit AIProviderError", async () => {
    mockCreateFn.mockRejectedValue(new APIError(429, {}, "Rate limited", new Headers()));

    await expect(new AnthropicProvider("sk-ant-test").complete({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
      temperature: 0.5,
      model: "claude-sonnet-5-5",
    })).rejects.toMatchObject({ code: "rate_limit", retryable: true });
  });
});

describe("toAnthropicMessages (§46.4) — provider-agnostic AIMessage[] to Anthropic's shape", () => {
  it("folds consecutive tool-result messages from one assistant turn into a single user turn", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "What's my order status?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call-1", name: "get_order_status", arguments: '{"orderId":"1"}' },
          { id: "call-2", name: "get_shipping_eta", arguments: '{"orderId":"1"}' },
        ],
      },
      { role: "tool", content: "shipped", tool_call_id: "call-1" },
      { role: "tool", content: "2 days", tool_call_id: "call-2" },
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call-1", content: "shipped" },
        { type: "tool_result", tool_use_id: "call-2", content: "2 days" },
      ],
    });
  });

  it("concatenates multiple system messages with a blank line", () => {
    const { system } = toAnthropicMessages([
      { role: "system", content: "First." },
      { role: "system", content: "Second." },
      { role: "user", content: "hi" },
    ]);
    expect(system).toBe("First.\n\nSecond.");
  });
});

describe("AnthropicProvider model catalog and per-model request shape", () => {
  beforeEach(() => {
    mockCreateFn.mockReset();
    mockCreateFn.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });

  const base = { messages: [{ role: "user" as const, content: "hi" }], maxTokens: 2048, temperature: 0.7 };

  it.each(["claude-3-5-haiku-20241022", "claude-3-opus-20240229", "claude-sonnet-4-20250514", "gpt-4o-mini"])(
    "refuses unsupported/retired model %s before any network call, without substituting another model",
    async (model) => {
      const error = await new AnthropicProvider("sk-ant-test").complete({ ...base, model }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AIProviderError);
      expect(error).toMatchObject({ code: "invalid_request", retryable: false });
      expect((error as Error).message).toContain(model);
      expect(mockCreateFn).not.toHaveBeenCalled();
    }
  );

  it.each(["claude-sonnet-5-5", "claude-opus-5-5"])(
    "%s: omits temperature, sets low effort and leaves max_tokens room for adaptive thinking",
    async (model) => {
      await new AnthropicProvider("sk-ant-test").complete({ ...base, model });
      const params = mockCreateFn.mock.calls[0][0];
      expect(params.model).toBe(model);
      expect(params).not.toHaveProperty("temperature");
      expect(params.output_config).toEqual({ effort: "low" });
      expect(params.max_tokens).toBe(8192);
      expect(params).not.toHaveProperty("thinking");
    }
  );

  it("claude-haiku-4-5: sends the business temperature and max_tokens, no effort", async () => {
    await new AnthropicProvider("sk-ant-test").complete({ ...base, model: "claude-haiku-4-5" });
    const params = mockCreateFn.mock.calls[0][0];
    expect(params.temperature).toBe(0.7);
    expect(params.max_tokens).toBe(2048);
    expect(params).not.toHaveProperty("output_config");
  });

  it("keeps a larger business max_tokens on thinking models", async () => {
    await new AnthropicProvider("sk-ant-test").complete({ ...base, maxTokens: 12000, model: "claude-sonnet-5-5" });
    expect(mockCreateFn.mock.calls[0][0].max_tokens).toBe(12000);
  });

  it("reads text by block type, ignoring a leading (empty) thinking block", async () => {
    mockCreateFn.mockResolvedValue({
      content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "Answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    const result = await new AnthropicProvider("sk-ant-test").complete({ ...base, model: "claude-sonnet-5-5" });
    expect(result).toMatchObject({ type: "text", text: "Answer" });
  });

  it("a refusal is an honest non-retryable error, never an empty 'reply'", async () => {
    mockCreateFn.mockResolvedValue({ content: [], stop_reason: "refusal", usage: { input_tokens: 3, output_tokens: 0 } });
    await expect(
      new AnthropicProvider("sk-ant-test").complete({ ...base, model: "claude-sonnet-5-5" })
    ).rejects.toMatchObject({ code: "invalid_request", retryable: false });
  });

  it("max_tokens spent before any reply text is an honest error", async () => {
    mockCreateFn.mockResolvedValue({
      content: [{ type: "thinking", thinking: "", signature: "sig" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 3, output_tokens: 8192 },
    });
    await expect(
      new AnthropicProvider("sk-ant-test").complete({ ...base, model: "claude-opus-5-5" })
    ).rejects.toMatchObject({ code: "invalid_request", retryable: false });
  });

  it("returns the tool_use turn with its thinking blocks, and replays it unchanged on the next call", async () => {
    mockCreateFn.mockResolvedValueOnce({
      content: [
        { type: "thinking", thinking: "", signature: "sig-1" },
        { type: "text", text: "Let me open a ticket." },
        { type: "tool_use", id: "toolu_9", name: "create_ticket", input: { title: "Broken scooter" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const provider = new AnthropicProvider("sk-ant-test");
    const first = await provider.complete({ ...base, model: "claude-sonnet-5-5" });
    expect(first.type).toBe("tool_calls");
    expect(first.providerContent?.provider).toBe("anthropic");

    await provider.complete({
      ...base,
      model: "claude-sonnet-5-5",
      messages: [
        ...base.messages,
        { role: "assistant", content: first.text ?? "", tool_calls: first.toolCalls, providerContent: first.providerContent },
        { role: "tool", content: '{"success":true}', tool_call_id: "toolu_9" },
      ],
    });
    const replayed = mockCreateFn.mock.calls[1][0].messages;
    expect(replayed[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig-1" },
        { type: "text", text: "Let me open a ticket." },
        { type: "tool_use", id: "toolu_9", name: "create_ticket", input: { title: "Broken scooter" } },
      ],
    });
    expect(replayed[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_9", content: '{"success":true}' }],
    });
  });
});
