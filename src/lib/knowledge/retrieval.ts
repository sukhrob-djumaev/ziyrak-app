import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { TenantContext } from "@/lib/tenancy/context";
import type { KnowledgeItem } from "@/lib/ai/types";

/**
 * PLAN.md §46.3 (Phase 3) / §18.1 — moved out of `ai/engine.ts`'s `chat()`
 * verbatim (knowledge/ owns "Retrieve relevant knowledge", §18.1's table),
 * with no behavior change: still the unbounded, unscored dump of every
 * active knowledge entry. §46.4 (Phase 4) is what replaces this with the
 * real `KnowledgeRetriever` contract (`knowledge/types.ts`) rewired onto
 * `semantic-search.ts` (§22.2) — this function is deleted then, not before.
 */
export async function getKnowledgeBase(ctx: TenantContext): Promise<KnowledgeItem[]> {
  const db = getScopedPrisma(ctx);
  const entries = await db.knowledgeEntry.findMany({
    where: { isActive: true },
    include: { category: true },
    orderBy: { priority: "desc" },
  });

  return entries.map((e: { category: { name: string }; title: string; content: string; priority: number }) => ({
    category: e.category.name,
    title: e.title,
    content: e.content,
    priority: e.priority,
  }));
}
