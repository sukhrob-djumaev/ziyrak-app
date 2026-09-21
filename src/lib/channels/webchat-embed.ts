/**
 * PLAN.md §20.4/§46.7 — the "small, versioned JS snippet businesses paste
 * into their site." Bumping `WIDGET_SCRIPT_VERSION` when `public/widget.js`
 * changes in an incompatible way gives businesses' already-embedded
 * snippets a real cache-busting/versioning hook without standing up a CDN
 * or build pipeline (explicitly Phase 8 scope, not this phase's) — a plain
 * `?v=` query string against a static Next.js `public/` asset.
 */
export const WIDGET_SCRIPT_VERSION = "1";

export function buildWebChatEmbedSnippet(input: { appBaseUrl: string; connectionId: string; token: string }): string {
  const src = `${input.appBaseUrl}/widget.js?v=${WIDGET_SCRIPT_VERSION}`;
  return `<script src="${src}" data-connection-id="${input.connectionId}" data-token="${input.token}" data-api-base="${input.appBaseUrl}" defer></script>`;
}
