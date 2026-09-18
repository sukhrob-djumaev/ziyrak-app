import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/identity/auth";
import { hasPermission, Permission } from "@/lib/rbac/rbac";
import { prisma } from "@/lib/prisma/raw-client";
import { resolveTenantPlacement } from "@/lib/platform/tenant-placement";
import type { TenantContext } from "@/lib/tenancy/context";

/**
 * PLAN.md §9.4 — hashes the presented key and compares against the stored
 * `keyHash`; never compares against a recoverable secret. `keyPrefix` is a
 * fast, non-secret lookup to narrow the candidate row(s) before the hash
 * comparison — it is not itself the authentication.
 */
async function authenticateApiKey(presentedKey: string): Promise<TenantContext | null> {
  const keyPrefix = presentedKey.slice(0, 16);
  const candidates = await prisma.apiKey.findMany({ where: { keyPrefix, isActive: true } });
  if (candidates.length === 0) return null;

  const presentedHash = crypto.createHash("sha256").update(presentedKey).digest("hex");
  const key = candidates.find((k) => k.keyHash === presentedHash);
  if (!key) return null;
  if (key.revokedAt) return null;
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return null;

  const placement = await resolveTenantPlacement(key.businessId);

  await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {
    // Best-effort usage tracking — never block authentication on it.
  });

  return {
    businessId: key.businessId,
    role: key.role,
    actor: { kind: "api_key", apiKeyId: key.id },
    dataConnection: placement.dataConnection,
  };
}

type HumanContextResult =
  | { ok: true; ctx: TenantContext }
  | { ok: false; reason: "no_user" | "no_membership" };

/**
 * PLAN.md §9.3/§15.1 — resolves a signed-in human's `TenantContext`.
 * `Membership.role` (not a JWT claim, §14.4) is the source of truth, looked
 * up fresh on every request so a revoked/changed membership takes effect
 * immediately rather than waiting for a 7-day token to expire.
 *
 * A `User` may hold `Membership` rows in more than one `Business` (§9.2 —
 * a consultant, a platform support engineer). This codebase has no
 * business-switcher yet (deferred alongside the polished signup flow,
 * §46.1/§46.2's "Explicitly deferred" sections), so the deterministic
 * choice here is the earliest-created membership — that never grants
 * access to a business the user isn't a member of, it only decides *which*
 * of their own businesses a bare-JWT request resolves to.
 */
async function resolveHumanContext(userId: string): Promise<HumanContextResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false, reason: "no_user" };

  const memberships = await prisma.membership.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });

  // §15.2 — platform_admin gets no tenant-resource permission implicitly.
  // A platform admin with no membership in any business is simply not a
  // member of one, exactly like anyone else; there is no platform-only
  // route in this codebase yet for `actor.kind === "platform_admin"` to
  // serve (that is future, explicitly-deferred support-access tooling).
  if (memberships.length === 0) return { ok: false, reason: "no_membership" };

  const membership = memberships[0];
  const placement = await resolveTenantPlacement(membership.businessId);

  return {
    ok: true,
    ctx: {
      businessId: membership.businessId,
      role: membership.role,
      actor: { kind: "user", userId: user.id },
      dataConnection: placement.dataConnection,
    },
  };
}

/**
 * Authenticate and authorize an API request, resolving a full
 * `TenantContext` (PLAN.md §8.2, §15.1) — not just `{userId, role}`.
 * Supports both cookie (JWT) and API key (X-API-Key header) auth.
 */
export async function requireAuth(
  request: NextRequest,
  permission?: Permission
): Promise<TenantContext | NextResponse> {
  // Try API key auth first
  const apiKey = request.headers.get("x-api-key");
  if (apiKey) {
    const ctx = await authenticateApiKey(apiKey);
    if (!ctx) {
      return NextResponse.json(
        { error: { code: "INVALID_API_KEY", message: "Invalid or inactive API key" } },
        { status: 401 }
      );
    }

    if (permission && !hasPermission(ctx.role ?? "", permission)) {
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: "Insufficient permissions" } },
        { status: 403 }
      );
    }

    return ctx;
  }

  // Fall back to cookie auth
  const token = request.cookies.get("owly-token")?.value;

  if (!token) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required. Use cookie or X-API-Key header." } },
      { status: 401 }
    );
  }

  const payload = verifyToken(token);
  if (!payload) {
    return NextResponse.json(
      { error: { code: "INVALID_TOKEN", message: "Invalid or expired token" } },
      { status: 401 }
    );
  }

  const result = await resolveHumanContext(payload.userId);
  if (!result.ok) {
    if (result.reason === "no_user") {
      return NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "User not found" } },
        { status: 401 }
      );
    }
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "You are not a member of any business" } },
      { status: 403 }
    );
  }

  if (permission && !hasPermission(result.ctx.role ?? "", permission)) {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Insufficient permissions" } },
      { status: 403 }
    );
  }

  return result.ctx;
}

/**
 * Type guard: check if result is a TenantContext (not an error response).
 */
export function isAuthenticated(
  result: TenantContext | NextResponse
): result is TenantContext {
  return !(result instanceof NextResponse);
}

/**
 * Same resolution as `requireAuth()`'s cookie branch, but for React Server
 * Components (dashboard pages), which have no `NextRequest` to read a
 * cookie from — they use `next/headers`'s `cookies()` instead. Returns
 * `null` on any failure (no cookie, invalid token, no membership) so a
 * page can redirect/render an empty state; pages are already behind
 * `src/proxy.ts`'s secure-by-default check before they render at all, so
 * this is a second, independent resolution for the *tenant* context a
 * Server Component needs to scope its own queries — not the sole gate.
 */
export async function getTenantContextFromCookies(): Promise<TenantContext | null> {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  const token = cookieStore.get("owly-token")?.value;
  if (!token) return null;

  const payload = verifyToken(token);
  if (!payload) return null;

  const result = await resolveHumanContext(payload.userId);
  return result.ok ? result.ctx : null;
}

/**
 * A human-readable name for the current actor, for use in authorship
 * fields (activity log entries, internal notes, transfer/snooze reasons)
 * that today read `auth.name` directly off the old flat auth context.
 * `TenantContext` deliberately doesn't carry this (§8.7's shape is
 * minimal) since most call sites never need it — this is a small,
 * on-demand lookup for the few that do.
 */
export async function resolveActorDisplayName(ctx: TenantContext): Promise<string> {
  switch (ctx.actor.kind) {
    case "user": {
      const user = await prisma.user.findUnique({
        where: { id: ctx.actor.userId },
        select: { name: true },
      });
      return user?.name || "User";
    }
    case "api_key":
      return "API";
    case "platform_admin":
      return "Platform Admin";
    case "channel_credential":
    case "ai_agent":
    case "system_job":
      return "System";
  }
}
