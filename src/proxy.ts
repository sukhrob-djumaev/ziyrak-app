import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/client-ip";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { verifyToken, verifyActiveToken } from "@/lib/identity/auth";
import { isPublicApiPath } from "@/lib/identity/public-api-paths";

const API_VERSION = "2026-04-07";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-API-Version": API_VERSION,
};

const CORS_ORIGIN = process.env.CORS_ORIGIN || "";

function generateRequestId(): string {
  return crypto.randomUUID();
}

function addHeaders(
  response: NextResponse,
  requestId: string,
  rateLimit?: { limit: number; remaining: number; resetAt: number },
  options?: { skipCors?: boolean }
): NextResponse {
  // Security headers
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }

  // Request ID
  response.headers.set("X-Request-Id", requestId);

  // Rate limit headers
  if (rateLimit) {
    response.headers.set("X-RateLimit-Limit", String(rateLimit.limit));
    response.headers.set("X-RateLimit-Remaining", String(Math.max(0, rateLimit.remaining)));
    response.headers.set("X-RateLimit-Reset", String(Math.ceil(rateLimit.resetAt / 1000)));
  }

  // CORS — skipped for the public Web Chat widget routes (see proxy() below):
  // their allowed origins are per-connection data, so the route handlers set
  // `Access-Control-Allow-Origin` themselves rather than one global value.
  if (CORS_ORIGIN && !options?.skipCors) {
    response.headers.set("Access-Control-Allow-Origin", CORS_ORIGIN);
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, X-Request-Id");
    response.headers.set("Access-Control-Expose-Headers", "X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-API-Version");
    response.headers.set("Access-Control-Max-Age", "86400");
  }

  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestId = request.headers.get("x-request-id") || generateRequestId();

  // Static files and Next.js internals. `/widget.js` is the embeddable Web
  // Chat script (PLAN.md §20.4/§46.7): it is loaded by *anonymous visitors on
  // a business's own website*, so it must never be behind the dashboard's
  // login redirect (found by serving the production build — it 307'd to
  // /login, which would have made every embedded widget silently fail to load).
  if (
    pathname.startsWith("/_next") ||
    pathname === "/widget.js" ||
    pathname.startsWith("/favicon") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".svg") ||
    pathname.endsWith(".ico")
  ) {
    return NextResponse.next();
  }

  // PLAN.md §20.4/§46.7 — the embedded Web Chat widget calls these routes
  // cross-origin from a business's own site, so the global single-origin
  // CORS_ORIGIN policy below can neither apply (it is one fixed value) nor
  // block the preflight: the route handlers answer OPTIONS and set CORS
  // headers themselves, only for an origin on that connection's own
  // `allowedOrigins`.
  if (pathname.startsWith("/api/channels/webchat/")) {
    return addHeaders(NextResponse.next(), requestId, undefined, { skipCors: true });
  }

  // CORS preflight
  if (request.method === "OPTIONS" && CORS_ORIGIN) {
    return addHeaders(new NextResponse(null, { status: 204 }), requestId);
  }

  // Public page paths (not part of the /api/** requireAuth-coverage
  // contract in src/lib/public-api-paths.ts) plus the shared list of
  // public /api/** paths — auth routes, health, the OpenAPI spec, and
  // channel webhook endpoints authenticated via provider signature (or,
  // for the Web Chat widget reserved here per §46.2 task 5, a
  // per-connection publishable token) rather than a JWT/API key.
  const publicPagePaths = ["/login", "/setup", "/forgot-password", "/reset-password", "/verify-email"];
  const isPublic =
    publicPagePaths.some((p) => pathname.startsWith(p)) || isPublicApiPath(pathname);

  if (isPublicApiPath(pathname) && !pathname.startsWith("/api/auth")) {
    return addHeaders(NextResponse.next(), requestId);
  }

  // Rate limiting for the auth endpoint's login/signup/logout attempts. The
  // read-only status check (GET) is called by the login page and the
  // dashboard's onboarding checklist on every load; counting it against the
  // 5/min brute-force budget made ordinary navigation 429.
  if (pathname.startsWith("/api/auth") && request.method === "POST") {
    const ip = getClientIp(request);
    // Sign-out has its own, larger budget: counting it against the 5/min login
    // brute-force limit let a shared address block people from signing out.
    const action = await request.clone().json().then((b: { action?: unknown } | null) => b?.action, () => undefined);
    const isLogout = action === "logout";
    const limits = isLogout ? RATE_LIMITS.logout : RATE_LIMITS.auth;
    const rateResult = await checkRateLimit(`${isLogout ? "logout" : "auth"}:${ip}`, limits);

    if (!rateResult.allowed) {
      const response = NextResponse.json(
        { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests. Please try again later.", requestId } },
        { status: 429 }
      );
      response.headers.set("Retry-After", String(Math.ceil((rateResult.resetAt - Date.now()) / 1000)));
      return addHeaders(response, requestId, { limit: limits.maxRequests, remaining: 0, resetAt: rateResult.resetAt });
    }

    return addHeaders(NextResponse.next(), requestId, {
      limit: limits.maxRequests,
      remaining: rateResult.remaining,
      resetAt: rateResult.resetAt,
    });
  }

  if (isPublic) {
    return addHeaders(NextResponse.next(), requestId);
  }

  // General API rate limiting
  let apiRateInfo: { limit: number; remaining: number; resetAt: number } | undefined;
  if (pathname.startsWith("/api/")) {
    // A request with a validly signed session token is limited per session; everything else (anonymous, API key,
    // forged or expired token) per client address. Only the signature is checked here — requireAuth() still
    // decides whether the session is actually allowed to do anything.
    const sessionToken = request.cookies.get("owly-token")?.value;
    const session = sessionToken ? verifyToken(sessionToken) : null;
    const isStream = pathname === "/api/realtime";
    // Keyed by the token's own id (`jti`, signed, not attacker-chosen), not by the user: a stolen token that has
    // since been revoked keeps a valid signature, and keying by user would let it burn its owner's budget from
    // any address. A token without a `jti` (issued before sessions were revocable) falls back to the user.
    const sessionKey = session ? (session.jti ?? `user-${session.userId}`) : null;
    const bucket = sessionKey
      ? { key: `${isStream ? "stream" : "apisession"}:${sessionKey}`, config: isStream ? RATE_LIMITS.stream : RATE_LIMITS.apiUser }
      : { key: `api:${getClientIp(request)}`, config: RATE_LIMITS.api };
    const rateResult = await checkRateLimit(bucket.key, bucket.config);

    if (!rateResult.allowed) {
      const response = NextResponse.json(
        { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests. Please try again later.", requestId } },
        { status: 429 }
      );
      response.headers.set("Retry-After", String(Math.ceil((rateResult.resetAt - Date.now()) / 1000)));
      return addHeaders(response, requestId, { limit: bucket.config.maxRequests, remaining: 0, resetAt: rateResult.resetAt });
    }

    apiRateInfo = {
      limit: bucket.config.maxRequests,
      remaining: rateResult.remaining,
      resetAt: rateResult.resetAt,
    };
  }

  // Check for auth token (cookie) or API key (header)
  const token = request.cookies.get("owly-token")?.value;
  const apiKey = request.headers.get("x-api-key");

  if (!token && !apiKey) {
    if (pathname.startsWith("/api/")) {
      return addHeaders(
        NextResponse.json(
          { error: { code: "UNAUTHORIZED", message: "Authentication required", requestId } },
          { status: 401 }
        ),
        requestId,
        apiRateInfo
      );
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // API key auth is validated in route handlers (requireAuth), just pass through
  if (apiKey && !token) {
    return addHeaders(NextResponse.next(), requestId, apiRateInfo);
  }

  // Verify the JWT is well-formed AND validly signed (not just structurally
  // shaped). Real, database-backed authorization still happens in
  // requireAuth() for every route — this is a fast, cookie-only "optimistic"
  // check, per Next.js's own guidance for Proxy auth. Pages additionally
  // refuse a signed-out (revoked) session here, so a copied token cannot open
  // the dashboard after logout; API routes do the same lookup in requireAuth(),
  // so it is not repeated on every API call.
  const payload = token ? (pathname.startsWith("/api/") ? verifyToken(token) : await verifyActiveToken(token)) : null;
  if (!payload) {
    if (pathname.startsWith("/api/")) {
      return addHeaders(
        NextResponse.json(
          { error: { code: "INVALID_TOKEN", message: "Invalid authentication token", requestId } },
          { status: 401 }
        ),
        requestId,
        apiRateInfo
      );
    }
    const response = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.delete("owly-token");
    return response;
  }

  return addHeaders(NextResponse.next(), requestId, apiRateInfo);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
  // No explicit `runtime` here: Proxy always runs on Node.js and Next.js
  // throws a build error if `runtime` is set in a Proxy file's config
  // (verified against node_modules/next/dist/docs/.../file-conventions/proxy.md
  // and confirmed empirically against this Next.js 16.2.2 install).
};
