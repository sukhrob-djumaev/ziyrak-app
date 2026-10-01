/**
 * The small set of Anthropic models Ziyrak supports, shared by the provider,
 * server-side validation, the signup wizard and the settings page. Pure
 * constants (no server imports) so client components can use it too.
 *
 * Three tiers, deliberately not the full model list:
 *   fast      — economical, lowest latency
 *   balanced  — the default
 *   advanced  — highest capability, highest cost
 *
 * `sampling`: whether the model accepts a non-default `temperature`. Claude
 * Sonnet 5.5 rejects non-default sampling values and Claude Opus 5.5 rejects
 * sampling parameters entirely (both a 400), so the provider omits
 * `temperature` for them.
 * `adaptiveThinking`: the model thinks by default. Thinking counts toward
 * `max_tokens`, its blocks must be passed back unchanged inside a tool loop,
 * and depth is controlled with `output_config.effort`.
 *
 * A configured model id that is not in this list (for example a retired
 * `claude-3-5-haiku-20241022`) is never silently mapped to another model:
 * it stays readable, but saving or invoking it fails with an honest
 * "reselect a supported model" error.
 */

export type AnthropicModelTier = "fast" | "balanced" | "advanced";

export interface AnthropicModelOption {
  id: string;
  label: string;
  tier: AnthropicModelTier;
  sampling: boolean;
  adaptiveThinking: boolean;
}

export const ANTHROPIC_MODELS: readonly AnthropicModelOption[] = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — fast, economical", tier: "fast", sampling: true, adaptiveThinking: false },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 — balanced (recommended)", tier: "balanced", sampling: false, adaptiveThinking: true },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 — most capable, highest cost", tier: "advanced", sampling: false, adaptiveThinking: true },
];

export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5-5";

export function getAnthropicModel(id: string | null | undefined): AnthropicModelOption | undefined {
  return ANTHROPIC_MODELS.find((m) => m.id === id);
}

export function isSupportedAnthropicModel(id: string | null | undefined): boolean {
  return getAnthropicModel(id) !== undefined;
}

export function unsupportedAnthropicModelMessage(id: string): string {
  return (
    `Anthropic model "${id}" is no longer supported. ` +
    `Select one of: ${ANTHROPIC_MODELS.map((m) => m.id).join(", ")}.`
  );
}
