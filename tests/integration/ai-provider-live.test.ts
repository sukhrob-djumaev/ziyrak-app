import { describe, it, expect } from "vitest";
import { aiProviderRegistry } from "@/lib/ai/providers/registry";
import { AIProviderError } from "@/lib/ai/providers/types";
import { ANTHROPIC_DEFAULT_MODEL } from "@/lib/ai/providers/anthropic-models";

// The catalog default (Sonnet 5.5) unless ANTHROPIC_SMOKE_MODEL names another
// supported model, e.g. claude-haiku-4-5 for the cheapest run.
const SMOKE_MODEL = process.env.ANTHROPIC_SMOKE_MODEL || ANTHROPIC_DEFAULT_MODEL;

/**
 * PLAN.md §46.4/§34.2 — the one manual, credential-gated acceptance check
 * §46.4 itself names as not automatable: "Selecting 'Anthropic' in a
 * business's configuration results in real Anthropic API calls, verified
 * via the contract test suite and (manually, once) against a real
 * Anthropic key in a non-CI environment."
 *
 * This file lives under tests/integration/, which vitest.config.ts (what
 * `npm run test`/CI actually run) explicitly excludes — so it is
 * structurally impossible for it to run as part of the normal suite, not
 * merely skipped-and-counted. It is only reachable through the separate
 * vitest.integration.config.ts. Run it explicitly and only when you have a
 * real key:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... npm run test:smoke:anthropic
 *
 * The describe.skipIf() below is defense-in-depth for the (unsupported)
 * case of someone pointing vitest directly at this file without a key —
 * it skips cleanly with a clear reason instead of failing.
 *
 * No SDK/fetch mocking of any kind happens in this file — it goes through
 * the exact same AIProviderRegistry -> AnthropicProvider -> @anthropic-ai/sdk
 * path production uses, making a real network request to Anthropic's API.
 * Kept to a small request (a one-word canned reply on the catalog's default
 * model; the provider raises max_tokens to leave room for adaptive thinking,
 * which this prompt does not need at low effort) — no tool-calling is
 * exercised, since a plain text completion is sufficient to prove the
 * contract this phase's acceptance criterion is actually about (dispatch is
 * real, the request succeeds, a non-empty completion with usage comes
 * back). The key is read once from the environment and never logged,
 * echoed, or written anywhere.
 */
describe.skipIf(!process.env.ANTHROPIC_API_KEY)(
  "LIVE smoke test: AIProviderRegistry -> AnthropicProvider -> real Anthropic API (§46.4)",
  () => {
    it("dispatches \"anthropic\" to a real AnthropicProvider and gets a real completion back", async () => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY must be set to run this smoke test.");

      const provider = aiProviderRegistry.get("anthropic", { apiKey });
      expect(provider.name).toBe("anthropic");

      const result = await provider.complete({
        messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
        maxTokens: 16,
        temperature: 0,
        model: SMOKE_MODEL,
      });

      expect(result.type).toBe("text");
      expect(typeof result.text).toBe("string");
      expect(result.text!.trim().length).toBeGreaterThan(0);

      // Anthropic's Messages API always returns usage (input_tokens/
      // output_tokens are non-optional on the response) — asserting it's
      // present and non-zero proves CompletionResult.usage is populated
      // from the real response, not a stub.
      expect(result.usage.promptTokens).toBeGreaterThan(0);
      expect(result.usage.completionTokens).toBeGreaterThan(0);
      expect(result.usage.totalTokens).toBe(result.usage.promptTokens + result.usage.completionTokens);
    }, 60000);

    it("refuses a retired model id before any network call", async () => {
      const provider = aiProviderRegistry.get("anthropic", { apiKey: process.env.ANTHROPIC_API_KEY! });
      await expect(
        provider.complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 16, temperature: 0, model: "claude-3-5-haiku-20241022" })
      ).rejects.toMatchObject({ code: "invalid_request", retryable: false });
    });
  }
);

/**
 * Bounded provider-failure check that needs only network reachability, not a
 * credential: a deliberately invalid key must reach Anthropic and come back
 * as a non-retryable `auth` AIProviderError (no retry spent, nothing billed).
 *
 *   ANTHROPIC_SMOKE_INVALID_KEY_CHECK=1 npm run test:smoke:anthropic
 */
describe.skipIf(process.env.ANTHROPIC_SMOKE_INVALID_KEY_CHECK !== "1")(
  "LIVE failure check: invalid Anthropic key fails honestly",
  () => {
    it("maps Anthropic's 401 to a non-retryable auth error", async () => {
      const provider = aiProviderRegistry.get("anthropic", { apiKey: "sk-ant-invalid-ziyrak-smoke-check" });
      const error = await provider
        .complete({ messages: [{ role: "user", content: "hi" }], maxTokens: 16, temperature: 0, model: SMOKE_MODEL })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AIProviderError);
      expect(error).toMatchObject({ code: "auth", retryable: false });
    }, 30000);
  }
);
