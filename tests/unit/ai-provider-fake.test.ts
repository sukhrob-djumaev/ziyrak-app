import { describe, it, expect } from "vitest";
import { FakeAIProvider, FakeEmbeddingProvider } from "@/lib/ai/providers/fake";
import {
  assertProviderIdentity,
  assertTextCompletionContract,
  assertToolCallCompletionContract,
} from "../helpers/ai-provider-contract";

describe("FakeAIProvider (§21.4) satisfies the AIProvider contract", () => {
  it("has a well-formed name/capabilities", () => {
    assertProviderIdentity(new FakeAIProvider(), "fake");
  });

  it("returns a text completion by default", async () => {
    await assertTextCompletionContract(new FakeAIProvider());
  });

  it("can be configured to simulate a tool call", async () => {
    const provider = new FakeAIProvider([
      {
        type: "tool_calls",
        toolCalls: [{ id: "call-1", name: "get_order_status", arguments: JSON.stringify({ orderId: "123" }) }],
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      },
    ]);
    await assertToolCallCompletionContract(provider, "get_order_status");
  });

  it("returns canned responses in sequence, simulating a tool-call round trip", async () => {
    const provider = new FakeAIProvider([
      {
        type: "tool_calls",
        toolCalls: [{ id: "call-1", name: "get_order_status", arguments: "{}" }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      { type: "text", text: "Your order shipped.", usage: { promptTokens: 15, completionTokens: 5, totalTokens: 20 } },
    ]);

    const first = await provider.complete({ messages: [], maxTokens: 100, temperature: 0.7, model: "fake" });
    expect(first.type).toBe("tool_calls");
    const second = await provider.complete({ messages: [], maxTokens: 100, temperature: 0.7, model: "fake" });
    expect(second.type).toBe("text");
    expect(second.text).toBe("Your order shipped.");
  });

  it("records every request it received", async () => {
    const provider = new FakeAIProvider();
    const request = { messages: [{ role: "user" as const, content: "hi" }], maxTokens: 10, temperature: 0.5, model: "fake" };
    await provider.complete(request);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toEqual(request);
  });
});

describe("FakeEmbeddingProvider (§21.5) satisfies the EmbeddingProvider contract", () => {
  it("returns a deterministic, content-derived vector of the configured dimensionality", async () => {
    const provider = new FakeEmbeddingProvider(4);
    const result = await provider.embed("hello world");
    expect(result.vector).toHaveLength(4);
    expect(result.usage.totalTokens).toBeGreaterThan(0);

    const again = await provider.embed("hello world");
    expect(again.vector).toEqual(result.vector);

    const different = await provider.embed("goodbye world");
    expect(different.vector).not.toEqual(result.vector);
  });

  it("records every text it was asked to embed", async () => {
    const provider = new FakeEmbeddingProvider();
    await provider.embed("one");
    await provider.embed("two");
    expect(provider.requests).toEqual(["one", "two"]);
  });
});
