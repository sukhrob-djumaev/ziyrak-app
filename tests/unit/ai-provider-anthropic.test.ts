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
    await assertTextCompletionContract(new AnthropicProvider("sk-ant-test"));
  });

  it("wraps a tool-call completion", async () => {
    mockCreateFn.mockResolvedValue({
      content: [{ type: "tool_use", id: "toolu_1", name: "get_order_status", input: { orderId: "123" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 10 },
    });
    await assertToolCallCompletionContract(new AnthropicProvider("sk-ant-test"), "get_order_status");
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
      model: "claude-sonnet-4-20250514",
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
      model: "claude-sonnet-4-20250514",
    })).rejects.toMatchObject({ code: "auth", retryable: false } satisfies Partial<AIProviderError>);
  });

  it("maps a 429 to a retryable rate_limit AIProviderError", async () => {
    mockCreateFn.mockRejectedValue(new APIError(429, {}, "Rate limited", new Headers()));

    await expect(new AnthropicProvider("sk-ant-test").complete({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
      temperature: 0.5,
      model: "claude-sonnet-4-20250514",
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
