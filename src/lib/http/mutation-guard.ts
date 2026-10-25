/**
 * L1.3: policy for cookie-authenticated, state-changing API requests. SameSite=Lax stops ordinary cross-site
 * POSTs but not requests from a sibling subdomain or a form post with a simple content type, and route handlers
 * parse JSON regardless of the declared type. So a cookie-authenticated mutation must (1) come from this origin
 * and (2) declare JSON when it has a body. API-key and webhook traffic is not cookie-authenticated and not covered.
 */
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type MutationVerdict = { ok: true } | { ok: false; reason: "cross_site" | "origin_mismatch" | "content_type" };

export function checkCookieMutation(input: {
  method: string;
  headers: { get(name: string): string | null };
  /** The public host this deployment answers for (Host or the trusted forwarded host). */
  host: string;
}): MutationVerdict {
  if (!UNSAFE.has(input.method.toUpperCase())) return { ok: true };
  const site = input.headers.get("sec-fetch-site");
  if (site) {
    // Browsers send this and page scripts cannot forge it. `same-site` is a sibling subdomain.
    if (site !== "same-origin" && site !== "none") return { ok: false, reason: "cross_site" };
  } else {
    const origin = input.headers.get("origin");
    if (origin) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (!originHost || originHost.toLowerCase() !== input.host.toLowerCase()) return { ok: false, reason: "origin_mismatch" };
    }
  }
  const length = input.headers.get("content-length");
  const hasBody = input.headers.get("transfer-encoding") !== null || (length !== null && length !== "0");
  if (hasBody && !/^application\/(json|[a-z0-9.+-]+\+json)\s*(;|$)/i.test(input.headers.get("content-type") ?? "")) {
    return { ok: false, reason: "content_type" };
  }
  return { ok: true };
}
