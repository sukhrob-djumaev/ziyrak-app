/**
 * PLAN.md §10.2 — `PlatformDefaults`: code/env constants, not a DB table.
 * `BusinessConfig`'s nullable AI fields (§46.1) merge under these — only a
 * field a business has actually set overrides its corresponding default.
 */
export const PLATFORM_AI_DEFAULTS = {
  aiProvider: "openai",
  aiModel: "gpt-4o-mini",
  embeddingProvider: "openai",
  maxTokens: 2048,
  temperature: 0.7,
} as const;
