import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { TenantContext } from "@/lib/tenancy/context";
import { logger } from "@/lib/observability/logger";

/**
 * PLAN.md §46.4 task 8/§39.1 — persists `CompletionResult.usage`/
 * `EmbeddingResult.usage` per call, tenant-scoped, to the new
 * `AIInteractionLog` table (this phase's implementation-time decision
 * between that and a `Message.metadata` extension, §38.1 — a new table
 * was chosen since `Message` has no `metadata` column today and embedding
 * calls aren't tied to a `Message` at all). Best-effort: a failure to
 * record usage must never fail the AI response that already succeeded.
 */
export interface AIInteractionUsage {
  conversationId?: string;
  kind: "generation" | "embedding";
  provider: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens: number;
}

export async function recordAIInteraction(ctx: TenantContext, usage: AIInteractionUsage): Promise<void> {
  try {
    const db = getScopedPrisma(ctx);
    await db.aIInteractionLog.create({
      data: {
        businessId: ctx.businessId,
        conversationId: usage.conversationId,
        kind: usage.kind,
        provider: usage.provider,
        model: usage.model,
        promptTokens: usage.promptTokens ?? null,
        completionTokens: usage.completionTokens ?? null,
        totalTokens: usage.totalTokens,
      },
    });
  } catch (error) {
    logger.error("Failed to record AI interaction usage:", error);
  }
}
