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

interface DataPlaneEntry {
  client: PrismaClient;
  /** The profile's `connectionSecretRef` this client was built from; a different value means the secret changed. */
  secretRef: string | null;
}

const dataPlaneClients = new Map<string, DataPlaneEntry>();

const DEDICATED_PREFIX = "dedicated:";
const DEDICATED_POOL_MAX = 5;

/** In-flight queries on a replaced client get this long to finish before it is disconnected. */
const REPLACED_CLIENT_GRACE_MS = 60_000;

/**
 * Returns the `dedicated:<profileId>` key for a profile, building its Prisma
 * client on first use and **rebuilding it whenever the profile's secret has
 * changed** (the profile is re-read on every resolve — one primary-key read —
 * so a rotation, or the swap to the restricted RLS role, reaches every
 * process within its next request instead of waiting for a restart).
 */
export async function ensureDedicatedClient(profileId: string): Promise<string> {
  const key = `${DEDICATED_PREFIX}${profileId}`;
  const profile = await rawClient.databaseProfile.findUnique({ where: { id: profileId } });
  if (!profile) throw new Error(`DatabaseProfile "${profileId}" does not exist.`);

  const cached = dataPlaneClients.get(key);
  if (cached && cached.secretRef === profile.connectionSecretRef) return key;

  const connectionString = await getSecretResolver().decrypt(JSON.parse(profile.connectionSecretRef) as EncryptedSecret);
  const adapter = new PrismaPg({ connectionString, max: DEDICATED_POOL_MAX });
  dataPlaneClients.set(key, { client: new PrismaClient({ adapter }), secretRef: profile.connectionSecretRef });
  if (cached) setTimeout(() => void cached.client.$disconnect().catch(() => {}), REPLACED_CLIENT_GRACE_MS).unref();
  return key;
}

/** Disconnects and forgets one dedicated profile's client (e.g. after its secret changed), so the next resolve reconnects. */
export async function closeDedicatedClient(profileId: string): Promise<void> {
  const key = `${DEDICATED_PREFIX}${profileId}`;
  const entry = dataPlaneClients.get(key);
  dataPlaneClients.delete(key);
  await entry?.client.$disconnect();
}

/** Disconnects every dedicated client (shutdown, tests, secret rotation). */
export async function closeDedicatedClients(): Promise<void> {
  const clients = Array.from(dataPlaneClients.values()).map((entry) => entry.client);
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
  if (cached) return cached.client;

  throw new Error(
    `No data-plane client registered for connection "${dataConnection}" — resolve the business's placement (resolveTenantPlacement) before using its data connection.`
  );
}
