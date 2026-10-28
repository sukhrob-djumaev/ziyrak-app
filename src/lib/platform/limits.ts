import type { Prisma } from "@/generated/prisma/client";

/**
 * L4.1c — platform-wide limits (docs/l4.1-catalog-entitlements-design.md section 7). The keys, defaults and
 * bounds live in code; a `PlatformLimit` row overrides a default. A limit is a safety ceiling for the whole
 * platform, never a per-workspace allowance (those stay on `WorkspaceAiAllowance` and the package).
 */
export const PLATFORM_LIMITS = {
  monthly_generation_tokens_ceiling: { label: "Generation tokens per UTC month, all workspaces", def: 1_000_000_000, max: 2_000_000_000 },
  monthly_embedding_tokens_ceiling: { label: "Embedding tokens per UTC month, all workspaces", def: 1_000_000_000, max: 2_000_000_000 },
  max_new_workspaces_per_day: { label: "New workspaces per UTC day, all signups", def: 1000, max: 1_000_000 },
} as const;

export type PlatformLimitKey = keyof typeof PLATFORM_LIMITS;
export const PLATFORM_LIMIT_KEYS = Object.keys(PLATFORM_LIMITS) as PlatformLimitKey[];

/** Serializes the platform-wide ceiling check. Taken after any workspace row lock, never before it. */
export const PLATFORM_CEILING_LOCK = 92843;
/** Serializes the daily new-workspace count so two signups cannot both pass the last slot. */
export const SIGNUP_CAP_LOCK = 92844;

type Reader = Pick<Prisma.TransactionClient, "platformLimit">;

export async function readLimit(db: Reader, key: PlatformLimitKey): Promise<number> {
  const row = await db.platformLimit.findUnique({ where: { key } });
  return row ? row.value : PLATFORM_LIMITS[key].def;
}

/** Console view: every registered limit with its effective value and whether it is still the code default. */
export async function listLimits(db: Reader) {
  const rows = await db.platformLimit.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return PLATFORM_LIMIT_KEYS.map((key) => ({
    key,
    label: PLATFORM_LIMITS[key].label,
    value: byKey.get(key) ?? PLATFORM_LIMITS[key].def,
    isDefault: !byKey.has(key),
    max: PLATFORM_LIMITS[key].max,
  }));
}
