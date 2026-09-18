/**
 * PLAN.md §14.2 — the single source of truth for which `/api/**` paths are
 * exempt from authentication (`src/proxy.ts`'s secure-by-default check) and
 * therefore also exempt from the "does this route call requireAuth()"
 * static check (`tests/security/route-auth-coverage.test.ts`,
 * §33.4-equivalent deliberate-violation test for §14.2/§36). Both import
 * from here so the two checks can never drift apart.
 */
export const PUBLIC_PATH_PREFIXES = [
  "/api/auth",
  "/api/health",
  "/api/openapi.json",
  // Channel webhook endpoints — authenticated via provider signature (or,
  // for the Web Chat widget reserved here per §46.2 task 5, a
  // per-connection publishable token), never a JWT/API key.
  "/api/channels/phone/",
  "/api/channels/sms",
  "/api/channels/telegram",
  "/api/channels/webchat/",
];

export function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_PATH_PREFIXES.some((p) => pathname.startsWith(p));
}
