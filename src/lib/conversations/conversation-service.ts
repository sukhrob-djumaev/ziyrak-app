import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { TenantContext } from "@/lib/tenancy/context";
import { logActivity } from "@/lib/observability/activity";

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
  id?: string,
  /** The `ChannelConnection` the conversation arrived on — stamped so a later human reply is sent back through the same one (PLAN.md §46.7), not "whichever is first". */
  connectionId?: string
) {
  const db = getScopedPrisma(ctx);
  const conversation = await db.conversation.create({
    data: {
      ...(id && { id }),
      businessId: ctx.businessId,
      channel,
      customerName,
      customerContact,
      ...(customerId && { customerId }),
      ...(connectionId && { metadata: { channelConnectionId: connectionId } }),
    },
  });
  await logActivity(ctx, "conversation.created", "conversation", conversation.id, `New ${channel} conversation started by ${customerName}`, undefined, { channel });
  return conversation;
}
