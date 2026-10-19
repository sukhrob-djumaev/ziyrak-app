import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { streamPermission } from "@/lib/identity/stream-authority";
import type { EventPayload } from "@/lib/realtime/realtime";

function id(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : undefined;
}
export async function projectDashboardEvent(
  ctx: TenantContext,
  ceiling: TenantContext,
  event: EventPayload
): Promise<EventPayload | null> {
  if (!event || typeof event !== "object" || !event.data || typeof event.data !== "object")
    return null;
  const db = getScopedPrisma(ctx),
    conversationId = id(event.conversationId ?? event.data.conversationId);
  if (event.data.conversationId !== undefined && event.data.conversationId !== conversationId)
    return null;
  const hint = (data: Record<string, unknown>, conv = conversationId): EventPayload => ({
    type: event.type,
    ...(conv && { conversationId: conv }),
    data,
    timestamp: new Date().toISOString(),
  });
  if (event.type === "notification") {
    if (
      event.data.kind !== "action.pending_approval" ||
      !streamPermission(ctx, ceiling, "actions:read")
    )
      return null;
    const actionId = id(event.data.actionExecutionId);
    if (!actionId) return null;
    const action = await db.actionExecution.findFirst({
      where: { id: actionId, retiredAt: null, status: "pending_approval" },
      select: { id: true, tool: true, conversationId: true },
    });
    if (!action || (conversationId && conversationId !== action.conversationId)) return null;
    if (
      action.conversationId &&
      !(await db.conversation.findFirst({
        where: { id: action.conversationId, retiredAt: null },
        select: { id: true },
      }))
    )
      return null;
    return hint(
      {
        kind: "action.pending_approval",
        actionExecutionId: action.id,
        tool: action.tool,
        ...(action.conversationId && { conversationId: action.conversationId }),
      },
      action.conversationId ?? undefined
    );
  }
  if (event.type === "ticket:new" || event.type === "ticket:updated") {
    if (!streamPermission(ctx, ceiling, "tickets:read")) return null;
    const ticketId = id(event.data.ticketId ?? event.data.id);
    if (!ticketId) return null;
    const ticket = await db.ticket.findFirst({
      where: { id: ticketId, ...(conversationId && { conversationId }) },
      select: { id: true, conversationId: true },
    });
    if (!ticket) return null;
    if (
      ticket.conversationId &&
      !(await db.conversation.findFirst({
        where: { id: ticket.conversationId, retiredAt: null },
        select: { id: true },
      }))
    )
      return null;
    return hint({ ticketId: ticket.id }, ticket.conversationId ?? undefined);
  }
  if (!conversationId || !streamPermission(ctx, ceiling, "conversations:read")) return null;
  if (
    ![
      "message:new",
      "message:updated",
      "conversation:new",
      "conversation:updated",
      "conversation:assigned",
      "typing:start",
      "typing:stop",
    ].includes(event.type)
  )
    return null;
  if (
    !(await db.conversation.findFirst({
      where: { id: conversationId, retiredAt: null },
      select: { id: true },
    }))
  )
    return null;
  if (event.type === "message:new" || event.type === "message:updated") {
    if (!streamPermission(ctx, ceiling, "messages:read")) return null;
    const messageId = id(event.data.messageId ?? event.data.id);
    if (
      !messageId ||
      (event.data.id && event.data.messageId && event.data.id !== event.data.messageId)
    )
      return null;
    const message = await db.message.findFirst({
      where: { id: messageId, conversationId },
      select: { id: true, role: true },
    });
    return message ? hint({ conversationId, messageId: message.id, role: message.role }) : null;
  }
  return hint({ conversationId });
}
/** Public widgets receive persisted public message fields, never internal hints. */
export async function projectWidgetEvent(
  ctx: TenantContext,
  conversationId: string,
  event: EventPayload
): Promise<EventPayload | null> {
  if (
    !event ||
    event.type !== "message:new" ||
    event.conversationId !== conversationId ||
    !event.data
  )
    return null;
  const messageId = id(event.data.messageId ?? event.data.id);
  if (!messageId) return null;
  if (event.data.conversationId !== undefined && event.data.conversationId !== conversationId)
    return null;
  if (event.data.id && event.data.messageId && event.data.id !== event.data.messageId) return null;
  const message = await getScopedPrisma(ctx).message.findFirst({
    where: {
      id: messageId,
      conversationId,
      role: { in: ["customer", "assistant"] },
      conversation: { is: { retiredAt: null } },
    },
    select: { id: true, role: true, content: true, createdAt: true },
  });
  return message
    ? {
        type: "message:new",
        conversationId,
        data: { ...message },
        timestamp: new Date().toISOString(),
      }
    : null;
}
