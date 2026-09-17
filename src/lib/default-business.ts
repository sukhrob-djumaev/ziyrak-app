import { prisma } from "@/lib/prisma/raw-client";

let cachedDefaultBusinessId: string | null = null;

/**
 * Phase 1 stopgap (PLAN.md §46.1). `businessId` is now NOT NULL on every
 * tenant-owned table, but no route or service is ctx-aware yet — that is
 * Phase 2's explicit scope. Until then, exactly one Business exists, so
 * every write from existing application code is tagged with it here rather
 * than left to fail a NOT NULL constraint at the database.
 *
 * This function is deleted, not extended, once Phase 2 replaces its call
 * sites with real `ctx.businessId` resolution.
 */
export async function getDefaultBusinessId(): Promise<string> {
  if (cachedDefaultBusinessId) return cachedDefaultBusinessId;
  const business = await prisma.business.findUniqueOrThrow({ where: { slug: "default" } });
  cachedDefaultBusinessId = business.id;
  return business.id;
}
