import { prisma as rawClient } from "@/lib/prisma/raw-client";
import type { PrismaClient } from "@/generated/prisma/client";

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

export async function resolveTenantPlacement(businessId: string): Promise<ResolvedPlacement> {
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
