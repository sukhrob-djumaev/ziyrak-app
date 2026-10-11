/**
 * Client IP for rate limiting (PLAN.md §46.8 security review).
 *
 * `x-forwarded-for` is only trustworthy for the entries appended by proxies
 * you run. With `TRUSTED_PROXY_HOPS=N` (N proxies in front of the app, e.g. 1
 * for a single ingress) the client is the Nth entry from the right, so
 * anything a caller prepends is ignored. Unset keeps the legacy behavior —
 * first entry, else `x-real-ip` — which is only correct when an edge proxy
 * overwrites the header; set it in any deployment where clients can reach
 * the app through a proxy that appends instead.
 */
export function getClientIp(request: { headers: Headers }): string {
  const hops = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "", 10);
  const forwarded = request.headers.get("x-forwarded-for");

  if (Number.isFinite(hops) && hops > 0) {
    const entries = (forwarded ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    if (entries.length === 0) return "unknown";
    return entries[Math.max(0, entries.length - hops)];
  }

  return forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}
