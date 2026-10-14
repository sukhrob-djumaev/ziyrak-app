import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { mergeConversations, snoozeConversation } from "@/lib/conversations/conversation-engine";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
let a: SeededBusiness,
  allowed: string,
  hidden: string,
  convA: string,
  convB: string,
  messageB: string;
beforeAll(async () => {
  a = await seedBusiness("p1-resource-scope");
  [allowed, hidden] = await Promise.all(
    ["allowed", "hidden"].map(
      async (name) =>
        (
          await prisma.channelConnection.create({
            data: { businessId: a.businessId, type: "webchat", name, isActive: true },
          })
        ).id
    )
  );
  [convA, convB] = await Promise.all(
    [allowed, hidden].map(
      async (id) =>
        (
          await prisma.conversation.create({
            data: {
              businessId: a.businessId,
              channel: "webchat",
              metadata: { channelConnectionId: id },
              customerName: id === allowed ? "Allowed" : "Private",
              customerContact: id,
            },
          })
        ).id
    )
  );
  messageB = (
    await prisma.message.create({
      data: {
        businessId: a.businessId,
        conversationId: convB,
        role: "customer",
        content: "Excluded content",
        mediaUrl: "https://example.invalid/private-media",
      },
    })
  ).id;
});
afterAll(async () => {
  if (a) await cleanupBusiness(a.businessId);
});
function restricted(ids = [allowed]) {
  return {
    ...a.ctx,
    resourceScope: {
      kind: "connections" as const,
      customerProfileAccess: "none" as const,
      connectionIds: ids,
    },
  };
}
describe("connection resource scope (real scoped PG)", () => {
  it("filters root list/direct-ID/count/groupBy, preserving caller OR", async () => {
    const db = getScopedPrisma(restricted());
    expect(
      (await db.conversation.findMany({ where: { OR: [{ id: convA }, { id: convB }] } })).map(
        (r) => r.id
      )
    ).toEqual([convA]);
    expect(await db.conversation.findUnique({ where: { id: convB } })).toBeNull();
    expect(await db.conversation.count()).toBe(1);
    expect(await db.conversation.groupBy({ by: ["customerName"], _count: true })).toEqual([
      expect.objectContaining({ customerName: "Allowed", _count: 1 }),
    ]);
  });
  it("filters related messages/media and refuses excluded parent writes", async () => {
    const db = getScopedPrisma(restricted());
    expect(await db.message.findUnique({ where: { id: messageB } })).toBeNull();
    await expect(
      db.message.create({
        data: {
          businessId: a.businessId,
          conversationId: convB,
          role: "assistant",
          content: "Unauthorized write",
        },
      })
    ).rejects.toThrow();
    expect(
      await prisma.message.count({
        where: { conversationId: convB, content: "Unauthorized write" },
      })
    ).toBe(0);
  });
  it("retains scope inside interactive transactions", async () => {
    const rows = await getScopedPrisma(restricted()).$transaction((tx) =>
      tx.conversation.findMany()
    );
    expect(rows.map((r) => r.id)).toEqual([convA]);
  });
  it("empty connection scope grants no resources", async () => {
    expect(await getScopedPrisma(restricted([])).conversation.count()).toBe(0);
  });
  it("does not turn missing or malformed human scope into workspace access", async () => {
    const ctx = { ...restricted(), resourceScope: undefined };
    expect(() => getScopedPrisma(ctx)).toThrow();
    expect(() =>
      getScopedPrisma({ ...a.ctx, resourceScope: { kind: "unknown" } as never })
    ).toThrow();
  });
  it("cannot move message ownership between connections even when both are visible", async () => {
    const db = getScopedPrisma(restricted([allowed, hidden]));
    await expect(
      db.message.update({ where: { id: messageB }, data: { conversationId: convA } })
    ).rejects.toThrow();
    expect(
      (await prisma.message.findUniqueOrThrow({ where: { id: messageB } })).conversationId
    ).toBe(convB);
  });
  it("cross-connection merge refuses before moving any rows", async () => {
    expect(await mergeConversations(a.ctx, convA, convB)).toBe(false);
    expect(
      (await prisma.message.findUniqueOrThrow({ where: { id: messageB } })).conversationId
    ).toBe(convB);
  });
  it("snooze keeps the authoritative connection stamp and its visibility", async () => {
    await snoozeConversation(
      restricted(),
      convA,
      new Date(Date.now() + 3600000),
      "Synthetic snooze",
      "Test actor"
    );
    const row = await getScopedPrisma(restricted()).conversation.findUniqueOrThrow({
      where: { id: convA },
    });
    expect(row.metadata).toMatchObject({
      channelConnectionId: allowed,
      snoozeReason: "Synthetic snooze",
    });
  });
});
