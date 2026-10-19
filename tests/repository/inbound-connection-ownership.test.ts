import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import {
  resolveOrCreateConversation,
  ConversationIdUnavailableError,
} from "@/lib/conversations/inbound";
import { buildMessageReceivedEvent } from "@/lib/events/types";
let a: SeededBusiness, b: SeededBusiness, connectionA: string, connectionB: string;
const channel = "p1-synthetic-multi-connection";
beforeAll(async () => {
  a = await seedBusiness("p1-connection-a");
  b = await seedBusiness("p1-connection-b");
  [connectionA, connectionB] = await Promise.all(
    ["A", "B"].map(
      async (name) =>
        (
          await prisma.channelConnection.create({
            data: { businessId: a.businessId, type: channel, name, isActive: true },
          })
        ).id
    )
  );
});
afterAll(async () => {
  if (a) await cleanupBusiness(a.businessId);
  if (b) await cleanupBusiness(b.businessId);
});
function event(connectionId: string, conversationId?: string) {
  return buildMessageReceivedEvent({
    businessId: a.businessId,
    channel,
    connectionId,
    conversationId,
    payload: {
      text: "Synthetic inbound",
      customerName: "Same person",
      customerContact: "same-test-contact",
    },
  });
}

describe("inbound connection ownership (real scoped Postgres)", () => {
  it("separates same-contact conversations across same-type connections and reuses only its own", async () => {
    const first = await resolveOrCreateConversation(a.ctx, event(connectionA));
    const second = await resolveOrCreateConversation(a.ctx, event(connectionB));
    expect(second.id).not.toBe(first.id);
    const again = await resolveOrCreateConversation(a.ctx, event(connectionB));
    expect(again.id).toBe(second.id);
    const rows = await prisma.conversation.findMany({
      where: { id: { in: [first.id, second.id] } },
    });
    expect(rows).toHaveLength(2);
    expect(
      rows.map((c) => (c.metadata as { channelConnectionId: string }).channelConnectionId).sort()
    ).toEqual([connectionA, connectionB].sort());
  });
  it("preserves an authorized internal chat continuation without inventing an external connection", async () => {
    const row = await prisma.conversation.create({
      data: {
        businessId: a.businessId,
        channel,
        customerContact: "same-test-contact",
        metadata: { channelConnectionId: connectionA },
      },
    });
    const internal = buildMessageReceivedEvent({
      businessId: a.businessId,
      channel: "api",
      connectionId: "internal-chat-api",
      conversationId: row.id,
      payload: { text: "Internal continuation", customerName: "API User", customerContact: "" },
    });
    expect((await resolveOrCreateConversation(a.ctx, internal)).id).toBe(row.id);
    await expect(resolveOrCreateConversation(b.ctx, internal)).rejects.toBeInstanceOf(
      ConversationIdUnavailableError
    );
  });
  it("rejects an explicitly supplied conversation from another connection before preparation", async () => {
    const row = await prisma.conversation.create({
      data: {
        businessId: a.businessId,
        channel,
        customerContact: "same-test-contact",
        metadata: { channelConnectionId: connectionA },
      },
    });
    await expect(
      resolveOrCreateConversation(a.ctx, event(connectionB, row.id))
    ).rejects.toBeInstanceOf(ConversationIdUnavailableError);
  });
  it("rejects an explicitly supplied foreign tenant conversation", async () => {
    const row = await prisma.conversation.create({
      data: { businessId: b.businessId, channel, customerContact: "same-test-contact" },
    });
    await expect(
      resolveOrCreateConversation(a.ctx, event(connectionA, row.id))
    ).rejects.toBeInstanceOf(ConversationIdUnavailableError);
  });
});
