import { requireSupportContext, SUPPORT_GRANT_HEADER } from "./support-request";
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyActiveToken } from "@/lib/identity/auth";
import { Permission } from "@/lib/rbac/rbac";
import { prisma } from "@/lib/prisma/raw-client";
import { resolveTenantPlacement } from "@/lib/platform/tenant-placement";
import { hasTenantPermission, scopeFromRecord, scopeIsWithin } from "@/lib/tenancy/resource-scope";
import type { TokenPayload } from "@/lib/identity/auth";
import type { TenantContext } from "@/lib/tenancy/context";

/**
 * PLAN.md §9.4 — hashes the presented key and compares against the stored
 * `keyHash`; never compares against a recoverable secret. `keyPrefix` is a
 * fast, non-secret lookup to narrow the candidate row(s) before the hash
 * comparison — it is not itself the authentication.
 */
async function authenticateApiKey(presentedKey: string): Promise<TenantContext | null> {
  const keyPrefix = presentedKey.slice(0, 16);
  const candidates = await prisma.apiKey.findMany({
    where: { keyPrefix, isActive: true },
    include: { connectionScopes: true },
  });
  if (candidates.length === 0) return null;

  const presentedHash = crypto.createHash("sha256").update(presentedKey).digest("hex");
  const key = candidates.find((k) => k.keyHash === presentedHash);
  if (!key) return null;
  if (!(["agent", "viewer"] as string[]).includes(key.role)) return null;
  let resourceScope;
  try {
    resourceScope = scopeFromRecord(key);
  } catch {
    return null;
  }
  if (key.scopeOrigin === "issuer") {
    if (!key.issuedByUserId) return null;
    const issuer = await prisma.membership.findUnique({
      where: { businessId_userId: { businessId: key.businessId, userId: key.issuedByUserId } },
      include: { connectionScopes: true },
    });
    if (!issuer || !(["admin", "owner"] as string[]).includes(issuer.role)) return null;
    try {
      if (!scopeIsWithin(resourceScope, scopeFromRecord(issuer))) return null;
    } catch {
      return null;
    }
  } else if (key.scopeOrigin !== "legacy_workspace") return null;
  const business = await prisma.business.findUnique({
    where: { id: key.businessId },
    select: { status: true },
  });
  if (business?.status !== "active") return null;
  if (key.revokedAt) return null;
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return null;

  const placement = await resolveTenantPlacement(key.businessId);

  await prisma.apiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {
      // Best-effort usage tracking — never block authentication on it.
    });

  return {
    businessId: key.businessId,
    role: key.role,
    actor: { kind: "api_key", apiKeyId: key.id },
    dataConnection: placement.dataConnection,
    resourceScope,
    authorization: { kind: "api_key", apiKeyId: key.id },
  };
}

type HumanContextResult =
  | { ok: true; ctx: TenantContext }
  | { ok: false; reason: "no_user" | "no_membership" | "selection_required" | "invalid_scope" };

/** P1: selection locates a current membership; it is never authority. */
export async function resolveHumanContext(
  userId: string,
  selectedWorkspace?: string,
  session?: TokenPayload
): Promise<HumanContextResult> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return { ok: false, reason: "no_user" };
  if (!selectedWorkspace) return { ok: false, reason: "selection_required" };
  const membership = await prisma.membership.findUnique({
    where: { businessId_userId: { businessId: selectedWorkspace, userId } },
    include: { connectionScopes: true, business: { select: { status: true } } },
  });
  if (!membership || membership.business.status !== "active")
    return { ok: false, reason: "no_membership" };
  let resourceScope;
  try {
    resourceScope = scopeFromRecord(membership);
  } catch {
    return { ok: false, reason: "invalid_scope" };
  }
  const placement = await resolveTenantPlacement(membership.businessId);
  return {
    ok: true,
    ctx: {
      businessId: membership.businessId,
      role: membership.role,
      actor: { kind: "user", userId },
      dataConnection: placement.dataConnection,
      resourceScope,
      authorization: {
        kind: "membership",
        userId,
        membershipId: membership.id,
        sessionJti: session?.jti,
        sessionExpiresAt: session?.exp,
      },
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
  // A chosen support locator is a distinct identity path. Any denial must not
  // fall back to a wider membership/key, even on an account that has one.
  if (request.headers.has(SUPPORT_GRANT_HEADER)) return requireSupportContext(request, permission);
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

    const requestedWorkspace = request.headers.get("x-workspace-id");
    if (requestedWorkspace && requestedWorkspace !== ctx.businessId)
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: "API key belongs to another workspace" } },
        { status: 403 }
      );

    if (permission && !hasTenantPermission(ctx, permission)) {
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: "Insufficient permissions" } },
        { status: 403 }
      );
    }

    return ctx;
  }

  // Fall back to cookie auth
  const token = request.cookies.get("ziyrak-token")?.value;

  if (!token) {
    return NextResponse.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required. Use cookie or X-API-Key header.",
        },
      },
      { status: 401 }
    );
  }

  const payload = await verifyActiveToken(token);
  if (!payload) {
    return NextResponse.json(
      { error: { code: "INVALID_TOKEN", message: "Invalid or expired token" } },
      { status: 401 }
    );
  }

  const cookieWorkspace = request.cookies.get("ziyrak-workspace")?.value;
  const headerWorkspace = request.headers.get("x-workspace-id") ?? undefined;
  if (cookieWorkspace && headerWorkspace && cookieWorkspace !== headerWorkspace)
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Conflicting workspace selection" } },
      { status: 403 }
    );
  const result = await resolveHumanContext(
    payload.userId,
    headerWorkspace ?? cookieWorkspace,
    payload
  );
  if (!result.ok) {
    if (result.reason === "selection_required")
      return NextResponse.json(
        {
          error: {
            code: "WORKSPACE_SELECTION_REQUIRED",
            message: "Choose a workspace to continue",
          },
        },
        { status: 409 }
      );
    if (result.reason === "no_user") {
      return NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "User not found" } },
        { status: 401 }
      );
    }
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "The selected workspace is unavailable" } },
      { status: 403 }
    );
  }

  if (permission && !hasTenantPermission(result.ctx, permission)) {
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
export function isAuthenticated(result: TenantContext | NextResponse): result is TenantContext {
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
  const token = cookieStore.get("ziyrak-token")?.value;
  if (!token) return null;

  const payload = await verifyActiveToken(token);
  if (!payload) return null;

  const result = await resolveHumanContext(
    payload.userId,
    cookieStore.get("ziyrak-workspace")?.value,
    payload
  );
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

/**
 * Who a signed-in human is, for display (header avatar/menu). Never includes
 * the password hash or any credential; `null` for a non-human actor.
 */
export async function resolveActorProfile(
  ctx: TenantContext
): Promise<{ id: string; name: string; username: string } | null> {
  if (ctx.actor.kind !== "user") return null;
  return prisma.user.findUnique({
    where: { id: ctx.actor.userId },
    select: { id: true, name: true, username: true },
  });
}
