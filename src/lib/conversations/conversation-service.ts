import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { TenantContext } from "@/lib/tenancy/context";

/**
 * PLAN.md §6 (`conversations/` owns "Conversation lifecycle") /§46.5 —
 * moved out of `ai/engine.ts`, which owned it only because that's where the
 * pre-Phase-3 codebase happened to put every conversation-adjacent
 * function. It does nothing AI-related (a plain `Conversation` insert), so
 * it belongs here — and, concretely, this move is what lets
 * `channels/phone-adapter.ts`'s call-start leg (and every other adapter)
 * create a conversation without importing `ai/`, closing the last channel
 * of the `channels/`→`ai/` boundary this phase removes the temporary
 * ESLint allowlist for.
 */
export async function createNewConversation(
  ctx: TenantContext,
  channel: string,
  customerName: string,
  customerContact: string,
  customerId?: string,
  /** Web Chat only (§20.4) — the widget generates its own conversation id client-side so it knows what to subscribe to before the async job that creates the row has run. */
  id?: string
) {
  const db = getScopedPrisma(ctx);
  return db.conversation.create({
    data: {
      ...(id && { id }),
      businessId: ctx.businessId,
      channel,
      customerName,
      customerContact,
      ...(customerId && { customerId }),
    },
  });
}
