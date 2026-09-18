import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { TenantContext } from "@/lib/tenancy/context";
import { emitNewMessage } from "@/lib/realtime/realtime";

/**
 * PLAN.md §46.3 (Phase 3) / §18.1 — moved out of `ai/engine.ts`'s `chat()`
 * verbatim (conversations/ owns "Persist + notify" and "Escalate if
 * needed", §18.1's table), with no behavior change. Each function is a
 * thin wrapper around the same Prisma calls `chat()` made inline before
 * this phase — not a new "EscalationManager" abstraction, per this phase's
 * own principle against over-specifying ahead of real need (§46.3).
 */

export async function recordEscalationSignal(
  ctx: TenantContext,
  conversationId: string,
  metadata: { escalationReason: string | undefined; sentiment: string; intent: string }
): Promise<void> {
  const db = getScopedPrisma(ctx);
  await db.conversation.update({
    where: { id: conversationId },
    data: { metadata },
  });
}

export async function appendCustomerMessage(
  ctx: TenantContext,
  conversationId: string,
  content: string
): Promise<{ id: string }> {
  const db = getScopedPrisma(ctx);
  return db.message.create({
    data: { businessId: ctx.businessId, conversationId, role: "customer", content },
  });
}

export async function appendAssistantMessage(
  ctx: TenantContext,
  conversationId: string,
  content: string
): Promise<{ id: string }> {
  const db = getScopedPrisma(ctx);
  const saved = await db.message.create({
    data: { businessId: ctx.businessId, conversationId, role: "assistant", content },
  });

  await db.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });

  return saved;
}

export async function escalateConversation(ctx: TenantContext, conversationId: string): Promise<void> {
  const db = getScopedPrisma(ctx);
  await db.conversation.update({
    where: { id: conversationId },
    data: { status: "escalated" },
  });
}

export function notifyNewAssistantMessage(
  ctx: TenantContext,
  conversationId: string,
  message: { id: string; content: string }
): void {
  emitNewMessage(ctx.businessId, conversationId, { id: message.id, role: "assistant", content: message.content });
}
