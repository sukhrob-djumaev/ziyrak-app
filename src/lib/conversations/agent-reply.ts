import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { getChannelAdapter } from "@/lib/channels/registry";
import { logActivity } from "@/lib/observability/activity";
import { logger } from "@/lib/observability/logger";

export type AgentReplyDelivery =
  | { status: "sent" }
  | { status: "not_applicable"; reason: string }
  | { status: "failed"; error: string };

/**
 * PLAN.md §44.3/§46.7 — a human agent taking over a conversation must reach
 * the customer on the channel they are actually using. Before this, the
 * dashboard's reply was only *persisted*: enough for Web Chat (whose widget
 * reads persisted messages) but the customer on WhatsApp/SMS/Telegram never
 * received it.
 *
 * `not_applicable` (rather than an error) for the two cases where persisting
 * *is* the delivery: Web Chat, and the internal `"api"` channel (no external
 * destination). The connection to send through is the one the conversation
 * arrived on (`metadata.channelConnectionId`, stamped at creation) — falling
 * back to the business's first active connection of that channel type for a
 * conversation that predates the stamp. Everything is resolved through the
 * tenant-scoped client from `ctx`, never from caller-supplied ids.
 */
export async function deliverAgentReply(ctx: TenantContext, conversationId: string, text: string): Promise<AgentReplyDelivery> {
  const db = getScopedPrisma(ctx);
  const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) return { status: "failed", error: "Conversation not found" };

  if (conversation.channel === "webchat" || conversation.channel === "api") {
    return { status: "not_applicable", reason: "Delivered by the persisted message itself" };
  }

  const adapter = getChannelAdapter(conversation.channel);
  if (!adapter) return { status: "failed", error: `No channel adapter registered for "${conversation.channel}"` };
  if (!conversation.customerContact) return { status: "failed", error: "The conversation has no customer contact to send to" };

  const stampedId = (conversation.metadata as Record<string, unknown> | null)?.channelConnectionId;
  const connection =
    (typeof stampedId === "string" ? await db.channelConnection.findFirst({ where: { id: stampedId, isActive: true } }) : null) ??
    (await db.channelConnection.findFirst({ where: { type: conversation.channel, isActive: true }, orderBy: { createdAt: "asc" } }));
  if (!connection) return { status: "failed", error: `No active ${conversation.channel} connection is configured` };

  const result = await adapter.sendMessage(ctx, connection.id, conversation.customerContact, { text });
  if (result.success) return { status: "sent" };

  logger.error("[deliverAgentReply] channel send failed", { businessId: ctx.businessId, conversationId, channel: conversation.channel, error: result.error });
  await logActivity(ctx, "message.delivery_failed", "conversation", conversationId, `A reply could not be delivered on ${conversation.channel}`, undefined, { error: result.error });
  return { status: "failed", error: result.error ?? "The channel reported a failure" };
}
