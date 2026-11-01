// Client-safe: no database imports.

/** Routes a held workspace can still reach: paying, and the person's own account and sign-in. Everything else is refused. */
const OPEN_API_PREFIXES = ["/api/billing/", "/api/auth/", "/api/me", "/api/workspaces", "/api/health"];
const OPEN_PAGE_PREFIXES = ["/billing", "/account"];

export function holdAllowsApiPath(pathname: string): boolean {
  return OPEN_API_PREFIXES.some((p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p.endsWith("/") ? p : `${p}/`));
}
export function holdAllowsPagePath(pathname: string): boolean {
  return OPEN_PAGE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
