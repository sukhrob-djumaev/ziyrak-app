import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateFn = vi.fn();
const mockFetchFn = vi.fn();

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  class MockOpenAI {
    embeddings = { create: mockCreateFn };
  }
  return { ...actual, default: MockOpenAI };
});

import { OpenAIEmbeddingProvider } from "@/lib/ai/providers/openai-embedding";
import { AIProviderError } from "@/lib/ai/providers/types";
import { APIError } from "openai";

describe("OpenAIEmbeddingProvider (§46.4/§21.5/§22.2)", () => {
  beforeEach(() => {
    mockCreateFn.mockReset();
    mockFetchFn.mockReset();
    vi.stubGlobal("fetch", mockFetchFn);
  });

  it("has a well-formed name/dimensions", () => {
    const provider = new OpenAIEmbeddingProvider("sk-test");
    expect(provider.name).toBe("openai");
    expect(provider.dimensions).toBeGreaterThan(0);
  });

  it("embeds text via the OpenAI SDK, never a direct fetch() to the embeddings endpoint", async () => {
    mockCreateFn.mockResolvedValue({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
      usage: { total_tokens: 4 },
    });

    const result = await new OpenAIEmbeddingProvider("sk-test").embed("hello");

    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
    expect(result.usage.totalTokens).toBe(4);
    expect(mockCreateFn).toHaveBeenCalledWith(
      expect.objectContaining({ model: "text-embedding-3-small", input: "hello" })
    );
    expect(mockFetchFn).not.toHaveBeenCalled();
  });

  it("truncates input to the model's input limit", async () => {
    mockCreateFn.mockResolvedValue({ data: [{ embedding: [] }], usage: { total_tokens: 0 } });
    const longText = "a".repeat(10000);

    await new OpenAIEmbeddingProvider("sk-test").embed(longText);

    const callArgs = mockCreateFn.mock.calls[0][0];
    expect((callArgs.input as string).length).toBeLessThanOrEqual(8000);
  });

  it("maps a 401 to a non-retryable auth AIProviderError", async () => {
    mockCreateFn.mockRejectedValue(new APIError(401, {}, "Invalid API key", new Headers()));

    await expect(new OpenAIEmbeddingProvider("bad-key").embed("hi")).rejects.toMatchObject({
      code: "auth",
      retryable: false,
    } satisfies Partial<AIProviderError>);
  });
});
