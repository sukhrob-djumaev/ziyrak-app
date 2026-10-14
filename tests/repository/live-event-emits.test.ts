import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * Live dashboard updates need the server to say when something changed: a
 * customer wrote, a conversation was opened, a conversation was escalated, an
 * AI action is waiting for approval. Each event goes only to that business's
 * own channel (PLAN.md §26.2). Real Postgres; the real realtime module.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/realtime/realtime", async (importOriginal) => importOriginal());

import { subscribe, tenantGlobalChannel } from "@/lib/realtime/realtime";
import { appendCustomerMessage, escalateConversation } from "@/lib/conversations/messaging";
import { createNewConversation } from "@/lib/conversations/conversation-service";
import { resolveOrCreateConversation } from "@/lib/conversations/inbound";
import { toolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/builtin";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let a: SeededBusiness;
let b: SeededBusiness;

beforeAll(async () => {
  a = await seedBusiness("live-emits-a");
  b = await seedBusiness("live-emits-b");
});

afterAll(async () => {
  await cleanupBusiness(a.businessId);
  await cleanupBusiness(b.businessId);
});

type Seen = { type: string; conversationId?: string; data: Record<string, unknown> };
function listen(business: SeededBusiness) {
  const seen: Seen[] = [];
  const stop = subscribe(tenantGlobalChannel(business.businessId), (event) =>
    seen.push(event as Seen)
  );
  return { seen, stop };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("server emits the events the dashboard needs, to the right tenant only", () => {
  it("a customer message", async () => {
    const conversation = await createNewConversation(a.ctx, "webchat", "Visitor", "visitor-1");
    const mine = listen(a);
    const theirs = listen(b);
    const message = await appendCustomerMessage(a.ctx, conversation.id, "hello");
    await settle();
    mine.stop();
    theirs.stop();
    expect(mine.seen).toContainEqual(
      expect.objectContaining({
        type: "message:new",
        conversationId: conversation.id,
        data: expect.objectContaining({ messageId: message.id, role: "customer" }),
      })
    );
    expect(theirs.seen).toHaveLength(0);
  });

  it("a conversation being escalated", async () => {
    const conversation = await createNewConversation(a.ctx, "webchat", "Visitor", "visitor-2");
    const mine = listen(a);
    await escalateConversation(a.ctx, conversation.id);
    await settle();
    mine.stop();
    expect(mine.seen).toContainEqual(
      expect.objectContaining({
        type: "conversation:updated",
        conversationId: conversation.id,
        data: expect.objectContaining({ status: "escalated" }),
      })
    );
  });

  it("a new conversation, from the service and from the inbound (Web Chat) path", async () => {
    const mine = listen(a);
    const created = await createNewConversation(a.ctx, "whatsapp", "Visitor", "+15550001");
    const connection = await getScopedPrisma(a.ctx).channelConnection.create({
      data: {
        businessId: a.businessId,
        type: "webchat",
        name: "Realtime fixture",
      },
    });
    const inboundId = `inbound-${Date.now()}`;
    await resolveOrCreateConversation(a.ctx, {
      id: "e1",
      type: "message.received",
      businessId: a.businessId,
      source: { channel: "webchat", connectionId: connection.id },
      conversationId: inboundId,
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      correlationId: "c1",
      payload: { customerName: "Web visitor", customerContact: "visitor-9", text: "hi" },
    } as never);
    await settle();
    mine.stop();
    const created2 = mine.seen
      .filter((e) => e.type === "conversation:new")
      .map((e) => e.conversationId);
    expect(created2).toEqual(expect.arrayContaining([created.id, inboundId]));
  });

  it("an AI action that needs approval", async () => {
    await getScopedPrisma(a.ctx).toolPolicy.upsert({
      where: { businessId_tool: { businessId: a.businessId, tool: "noop_test_action" } },
      update: { allowedForAI: true, requiresHumanApproval: true },
      create: {
        businessId: a.businessId,
        tool: "noop_test_action",
        allowedForAI: true,
        requiresHumanApproval: true,
      },
    });
    const mine = listen(a);
    const result = await toolRegistry.execute(
      {
        businessId: a.businessId,
        role: null,
        actor: { kind: "ai_agent", conversationId: "c", model: "m" },
        dataConnection: "shared-default",
      },
      "noop_test_action",
      {},
      { toolCallId: `tc-${Math.random()}` }
    );
    await settle();
    mine.stop();
    expect(result.status).toBe("pending_approval");
    expect(mine.seen).toContainEqual(
      expect.objectContaining({
        type: "notification",
        data: expect.objectContaining({ kind: "action.pending_approval" }),
      })
    );
  });
});
