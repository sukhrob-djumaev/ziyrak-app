import { prisma as rawClient } from "@/lib/prisma/raw-client";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getSecretResolver, type EncryptedSecret } from "@/lib/secrets";
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
 * A `TenantPlacement` pointing at any other profile is a dedicated-database
 * business (§46.9): the profile's `connectionSecretRef` is decrypted through
 * the `SecretResolver`, a Prisma client is opened for it once per process,
 * and the business resolves to `dedicated:<profileId>`. The DSN never leaves
 * this module — callers only ever see the opaque `dataConnection` key.
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
    // Dedicated placements are not cached across replicas: the primary-key
    // read is cheap, and a cutover/rollback must be seen immediately.
    const dataConnection = await ensureDedicatedClient(placement.databaseProfileId);
    return { dataConnection };
  }

  if (shared) await cacheSet(placementCacheKey(businessId), "shared-default", PLACEMENT_CACHE_TTL_SECONDS);
  return { dataConnection: "shared-default" };
}

const dataPlaneClients = new Map<string, PrismaClient>();

const DEDICATED_PREFIX = "dedicated:";
const DEDICATED_POOL_MAX = 5;

/**
 * Opens (once per process) the Prisma client for a dedicated `DatabaseProfile`
 * and registers it under `dedicated:<profileId>`. Known limit: a client stays
 * cached for the life of the process, so changing a profile's secret needs a
 * restart of the web/worker processes (or `closeDedicatedClients()`).
 */
export async function ensureDedicatedClient(profileId: string): Promise<string> {
  const key = `${DEDICATED_PREFIX}${profileId}`;
  if (dataPlaneClients.has(key)) return key;

  const profile = await rawClient.databaseProfile.findUnique({ where: { id: profileId } });
  if (!profile) throw new Error(`DatabaseProfile "${profileId}" does not exist.`);
  const connectionString = await getSecretResolver().decrypt(JSON.parse(profile.connectionSecretRef) as EncryptedSecret);
  const adapter = new PrismaPg({ connectionString, max: DEDICATED_POOL_MAX });
  dataPlaneClients.set(key, new PrismaClient({ adapter }));
  return key;
}

/** Disconnects every dedicated client (shutdown, tests, secret rotation). */
export async function closeDedicatedClients(): Promise<void> {
  const clients = Array.from(dataPlaneClients.values());
  dataPlaneClients.clear();
  await Promise.all(clients.map((client) => client.$disconnect()));
}

/**
 * Resolves an opaque `dataConnection` key (from `ResolvedPlacement`) to an
 * actual Prisma client: the control-plane client for `shared-default`, or the
 * client `resolveTenantPlacement()` registered for a dedicated profile.
 */
export function getDataPlaneClient(dataConnection: string): PrismaClient {
  if (dataConnection === "shared-default") return rawClient;

  const cached = dataPlaneClients.get(dataConnection);
  if (cached) return cached;

  throw new Error(
    `No data-plane client registered for connection "${dataConnection}" — resolve the business's placement (resolveTenantPlacement) before using its data connection.`
  );
}
