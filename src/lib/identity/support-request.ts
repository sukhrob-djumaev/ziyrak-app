import { NextRequest, NextResponse } from "next/server";
import type { Permission } from "@/lib/rbac/rbac";
import type { TenantContext } from "@/lib/tenancy/context";
import { validateResourceScope } from "@/lib/tenancy/resource-scope";
import { authorizeSupportUse } from "@/lib/platform/access/grants";
import { resolveTenantPlacement } from "@/lib/platform/tenant-placement";
import { checkRateLimit } from "@/lib/rate-limit";
import { AppError, toErrorResponse } from "@/lib/observability/errors";
import { requireAccountAuth, isAccountAuthenticated } from "./account-auth";

export const SUPPORT_GRANT_HEADER = "x-support-grant-id";
export function privateSupportResponse(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
const id = (value: string | null): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function unavailable(): never {
  throw new AppError(403, "SUPPORT_REQUEST_UNAVAILABLE", "This support request is unavailable");
}
async function resolveSupportRequest(
  request: NextRequest,
  permission: Permission | undefined,
  phase: "admission" | "exposure"
): Promise<TenantContext | NextResponse> {
  try {
    if (
      request.method !== "GET" ||
      request.nextUrl.pathname !== "/api/conversations" ||
      permission !== "conversations:read" ||
      !request.headers.has(SUPPORT_GRANT_HEADER) ||
      request.headers.has("x-api-key")
    )
      unavailable();
    const account = await requireAccountAuth(request);
    if (!isAccountAuthenticated(account)) return privateSupportResponse(account);
    const grantId = request.headers.get(SUPPORT_GRANT_HEADER),
      businessId = request.headers.get("x-workspace-id");
    if (!id(grantId) || !id(businessId))
      throw new AppError(
        400,
        "INVALID_SUPPORT_SELECTION",
        "Choose a valid support grant and workspace"
      );
    const selected = request.cookies.get("ziyrak-workspace")?.value;
    if (selected && selected !== businessId)
      throw new AppError(
        403,
        "WORKSPACE_SELECTION_CONFLICT",
        "Clear the different workspace selection before using this support grant"
      );
    if (phase === "admission") {
      const rate = await checkRateLimit(`support-list:actor:${account.user.id}`, {
        maxRequests: 60,
        windowMs: 60_000,
      });
      if (!rate.allowed)
        throw new AppError(
          429,
          "RATE_LIMIT_EXCEEDED",
          "Too many support requests. Try again later."
        );
    }
    // Finish potentially slow placement work BEFORE the final audited decision.
    // Initial admission still establishes the grant before resolving placement.
    const preparedPlacement =
      phase === "exposure" ? await resolveTenantPlacement(businessId) : null;
    const facts = await authorizeSupportUse(request.cookies.get("owly-token")!.value, {
      grantId,
      businessId,
      operation: "conversations:read",
    });
    const placement = preparedPlacement ?? (await resolveTenantPlacement(facts.businessId));
    if (
      facts.userId !== account.user.id ||
      facts.businessId !== businessId ||
      facts.grantId !== grantId ||
      facts.sessionJti !== account.session.jti ||
      facts.sessionExpiresAt !== account.session.exp ||
      facts.sessionExpiresAt * 1000 <= Date.now() ||
      facts.expiresAt.getTime() <= Date.now()
    )
      unavailable();
    return {
      businessId,
      dataConnection: placement.dataConnection,
      role: null,
      actor: { kind: "platform_admin", userId: facts.userId },
      resourceScope: validateResourceScope(facts.scope),
      authorization: {
        kind: "support",
        userId: facts.userId,
        grantId,
        allowedOperations: ["conversations:read"],
        sessionJti: facts.sessionJti,
        sessionExpiresAt: facts.sessionExpiresAt,
      },
      supportQuery: {
        method: "GET",
        pathname: "/api/conversations",
        operation: "conversations:read",
      },
    };
  } catch (error) {
    return privateSupportResponse(toErrorResponse(error));
  }
}
/** Explicit request-local grant selection; never a failed-member fallback. */
export function requireSupportContext(request: NextRequest, permission?: Permission) {
  return resolveSupportRequest(request, permission, "admission");
}
function scopeKey(ctx: TenantContext) {
  const scope = validateResourceScope(ctx.resourceScope);
  return JSON.stringify(
    scope.kind === "workspace"
      ? scope
      : { ...scope, connectionIds: [...scope.connectionIds].sort() }
  );
}
/** Final audited decision before response handoff. Changed scope discards BOTH
 * rows and count; it never turns a stale wider result into a fresh response.
 */
export async function recheckSupportExposure(
  request: NextRequest,
  ceiling: TenantContext
): Promise<NextResponse | null> {
  const fresh = await resolveSupportRequest(request, "conversations:read", "exposure");
  if (fresh instanceof NextResponse) return fresh;
  const initial = ceiling.authorization,
    current = fresh.authorization;
  if (
    ceiling.role !== null ||
    ceiling.actor.kind !== "platform_admin" ||
    initial?.kind !== "support" ||
    current?.kind !== "support" ||
    fresh.actor.kind !== "platform_admin" ||
    fresh.actor.userId !== ceiling.actor.userId ||
    fresh.businessId !== ceiling.businessId ||
    fresh.dataConnection !== ceiling.dataConnection ||
    current.grantId !== initial.grantId ||
    current.userId !== initial.userId ||
    current.sessionJti !== initial.sessionJti ||
    current.sessionExpiresAt !== initial.sessionExpiresAt ||
    scopeKey(fresh) !== scopeKey(ceiling)
  )
    return privateSupportResponse(
      toErrorResponse(
        new AppError(
          403,
          "SUPPORT_CONTEXT_CHANGED",
          "Support access changed. Refresh the limited list."
        )
      )
    );
  return null;
}
