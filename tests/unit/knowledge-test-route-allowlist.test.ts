import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * PLAN.md §46.9 task 5 — the provider allowlist must hold on every path that
 * turns a configured provider into a provider, including the knowledge-base
 * test route (found by the Phase 9 security review): a business whose policy
 * forbids its configured provider must not reach that provider here either.
 */
const { assertAiProviderPermitted, registryGet } = vi.hoisted(() => ({
  assertAiProviderPermitted: vi.fn(),
  registryGet: vi.fn(),
}));

vi.mock("@/lib/platform/infrastructure-policy", () => ({ assertAiProviderPermitted }));
vi.mock("@/lib/ai/providers/registry", () => ({ aiProviderRegistry: { get: registryGet } }));
vi.mock("@/lib/ai/config", () => ({
  resolveAIConfig: vi.fn().mockResolvedValue({ provider: "openai", model: "m", apiKey: "k", maxTokens: 10, temperature: 0 }),
}));
vi.mock("@/lib/knowledge/service", () => ({ listActiveEntriesForTest: vi.fn().mockResolvedValue([{ id: "e1", title: "t", content: "c", category: { name: "n", color: "#000" } }]) }));
vi.mock("@/lib/ai/usage", () => ({ recordAIInteraction: vi.fn() }));

import { AIProviderError } from "@/lib/ai/providers/types";
import { POST } from "@/app/api/knowledge/test/route";

const request = () =>
  new NextRequest("http://localhost/api/knowledge/test", { method: "POST", body: JSON.stringify({ question: "hi" }) });

describe("POST /api/knowledge/test — provider allowlist", () => {
  beforeEach(() => {
    assertAiProviderPermitted.mockReset();
    registryGet.mockReset();
  });

  it("refuses with 403, and never builds the provider, when the business's policy forbids it", async () => {
    assertAiProviderPermitted.mockRejectedValue(new AIProviderError("invalid_request", 'The AI provider "openai" is not permitted for this business by its infrastructure policy.', false));
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/not permitted/);
    expect(registryGet).not.toHaveBeenCalled();
  });

  it("checks the policy for the configured provider before using it", async () => {
    assertAiProviderPermitted.mockResolvedValue(undefined);
    registryGet.mockReturnValue({ complete: vi.fn().mockResolvedValue({ text: "ok", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }) });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(assertAiProviderPermitted).toHaveBeenCalledWith(expect.any(String), "openai");
  });
});
