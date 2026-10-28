import type { Prisma } from "@/generated/prisma/client";
import { AppError } from "@/lib/observability/errors";

export const BASELINE_ITEM_KEY = "legacy-baseline";

type Db = Pick<Prisma.TransactionClient, "workspacePurchase" | "catalogVersion">;

/**
 * Every code path that creates a workspace calls this inside its transaction, so a new workspace holds exactly today's
 * access until L4.2 chooses a commercial default. Fails loudly if the baseline bundle is missing (misconfigured database).
 * Kept free of the shared Prisma client so seed and migration scripts can import it.
 */
export async function ensureBaselinePurchase(db: Db, businessId: string): Promise<void> {
  const existing = await db.workspacePurchase.findFirst({ where: { businessId, state: "active", source: "baseline" }, select: { id: true } });
  if (existing) return;
  const version = await db.catalogVersion.findFirst({ where: { item: { key: BASELINE_ITEM_KEY }, state: "published" }, orderBy: { version: "desc" }, select: { id: true } });
  if (!version) throw new AppError(500, "INTERNAL_ERROR", "The baseline package is not configured");
  await db.workspacePurchase.create({ data: { businessId, versionId: version.id, source: "baseline", reason: "baseline for a new workspace" } });
}
