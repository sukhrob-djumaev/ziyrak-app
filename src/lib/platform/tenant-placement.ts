import { prisma as rawClient } from "@/lib/prisma/raw-client";
import type { PrismaClient } from "@/generated/prisma/client";
import { cacheDel, cacheGet, cacheSet, isCacheDistributed } from "@/lib/cache";

/**
 * PLAN.md §7.5/§28.2 — control-plane resolution seam. Every business always
 * resolves through this function; for every business without a Phase-9
 * override, `databaseProfileId === "shared-default"`, which is *defined* to
 * mean "the same connection the control plane itself uses" (§7.5), so no
 * `DatabaseProfile` row lookup or extra connection hop is needed for that
 * case. This is what lets Phase 1-8 pay zero operational cost for the
 * control-plane/data-plane split while still giving Phase 9 a real,
 * already-proven resolution path.
 *
 * Only `"shared-default"` is implemented — a `TenantPlacement` pointing at
 * any other profile means a dedicated-infrastructure business, which is
 * Phase 9 scope (§46.9) and deliberately not supported yet.
 */
export interface ResolvedPlacement {
  dataConnection: string;
}

/**
 * PLAN.md §28.4/§46.8 — short-TTL shared cache in front of the control-plane
 * lookup, which every request and job on every replica performs. Only
 * consulted when the cache is genuinely shared (Redis): an in-process cache
 * would let a placement change (Phase 9) go unseen by other replicas for
 * the TTL *and* offers no saving a database primary-key read doesn't. Only
 * a successful, supported placement is cached — a missing row or an
 * unsupported profile is re-read every time and keeps throwing.
 */
const PLACEMENT_CACHE_TTL_SECONDS = 30;

const placementCacheKey = (businessId: string) => `placement:${businessId}`;

export async function invalidateTenantPlacement(businessId: string): Promise<void> {
  await cacheDel(placementCacheKey(businessId));
}

export async function resolveTenantPlacement(businessId: string): Promise<ResolvedPlacement> {
  const shared = await isCacheDistributed();
  if (shared && (await cacheGet(placementCacheKey(businessId))) === "shared-default") {
    return { dataConnection: "shared-default" };
  }

  const placement = await rawClient.tenantPlacement.findUnique({ where: { businessId } });
  if (!placement) {
    throw new Error(
      `No TenantPlacement row for business ${businessId} — every Business must have one from the moment it is created (§7.5).`
    );
  }

  if (placement.databaseProfileId !== "shared-default") {
    throw new Error(
      `Business ${businessId} is placed on database profile "${placement.databaseProfileId}", but dedicated data-plane connections are Phase 9 scope (§46.9) and are not yet supported.`
    );
  }

  if (shared) await cacheSet(placementCacheKey(businessId), "shared-default", PLACEMENT_CACHE_TTL_SECONDS);
  return { dataConnection: "shared-default" };
}

const dataPlaneClients = new Map<string, PrismaClient>();

/**
 * Resolves an opaque `dataConnection` key (from `ResolvedPlacement`) to an
 * actual Prisma client. Until Phase 9, this is always the same control-plane
 * client — the cache exists so the seam is real (a future dedicated
 * connection would be cached here too) without costing anything today.
 */
export function getDataPlaneClient(dataConnection: string): PrismaClient {
  if (dataConnection === "shared-default") return rawClient;

  const cached = dataPlaneClients.get(dataConnection);
  if (cached) return cached;

  throw new Error(
    `No data-plane client registered for connection "${dataConnection}" — dedicated connections are Phase 9 scope (§46.9).`
  );
}
