import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
let a: SeededBusiness,
  b: SeededBusiness,
  allowed: string,
  visible: string,
  hidden: string,
  customerId: string;
beforeAll(async () => {
  a = await seedBusiness("p1-oracle-a");
  b = await seedBusiness("p1-oracle-b");
  const connections = await Promise.all(
    ["A", "B"].map((name) =>
      prisma.channelConnection.create({
        data: { businessId: a.businessId, type: "webchat", name, isActive: true },
      })
    )
  );
  allowed = connections[0].id;
  customerId = (
    await prisma.customer.create({ data: { businessId: a.businessId, name: "Shared profile" } })
  ).id;
  [visible, hidden] = await Promise.all(
    connections.map(
      async (row) =>
        (
          await prisma.conversation.create({
            data: {
              businessId: a.businessId,
              channel: "webchat",
              customerId,
              metadata: { channelConnectionId: row.id },
            },
          })
        ).id
    )
  );
  await prisma.automationRule.create({
    data: {
      businessId: a.businessId,
      name: "Workspace usage",
      type: "auto_reply",
      triggerCount: 73,
    },
  });
  await prisma.conversation.create({ data: { businessId: b.businessId, channel: "api" } });
});
afterAll(async () => {
  for (const row of [a, b]) if (row) await cleanupBusiness(row.businessId);
});
function scoped() {
  return getScopedPrisma({
    ...a.ctx,
    resourceScope: { kind: "connections", connectionIds: [allowed], customerProfileAccess: "read" },
  });
}
describe("scoped query oracles (real PG, independent review regressions)", () => {
  it("configuration counts and grouping keep their aggregate contract without exposing usage totals", async () => {
    const db = scoped();
    expect(await db.automationRule.count()).toBe(1);
    expect(await db.automationRule.aggregate({ _count: { id: true } })).toEqual({
      _count: { id: 1 },
    });
    expect(await db.automationRule.groupBy({ by: ["type"], _count: { id: true } })).toEqual([
      { type: "auto_reply", _count: { id: 1 } },
    ]);
  });
  it("scopes predicates inside filtered related counts", async () => {
    const row = await scoped().customer.findUniqueOrThrow({
      where: { id: customerId },
      select: {
        _count: {
          select: {
            conversations: {
              where: {
                customer: { conversations: { some: { id: hidden } } },
              },
            },
          },
        },
      },
    });
    expect(row._count.conversations).toBe(0);
  });
  it("does not expose an extension client that bypasses guarded transactions", async () => {
    await expect(async () =>
      scoped()
        .$extends({})
        .$transaction([prisma.conversation.findMany({ where: { businessId: b.businessId } })])
    ).rejects.toThrow();
  });
  it("rejects an excluded cursor in a nested history projection", async () => {
    await expect(
      scoped().customer.findUnique({
        where: { id: customerId },
        include: {
          conversations: { cursor: { id: hidden }, take: 1 },
        },
      })
    ).rejects.toThrow();
  });
  it("some/none/every see only authorized related history", async () => {
    const db = scoped();
    expect(
      await db.customer.count({
        where: { id: customerId, conversations: { some: { id: hidden } } },
      })
    ).toBe(0);
    expect(
      await db.customer.count({
        where: { id: customerId, conversations: { none: { id: hidden } } },
      })
    ).toBe(1);
    expect(
      await db.customer.count({
        where: { id: customerId, conversations: { every: { id: visible } } },
      })
    ).toBe(1);
  });
  it("combines none and every without dropping either restriction", async () => {
    expect(
      await scoped().customer.count({
        where: { id: customerId, conversations: { none: { id: visible }, every: { id: visible } } },
      })
    ).toBe(0);
  });
  it("rejects an excluded cursor", async () => {
    await expect(
      scoped().conversation.findMany({ cursor: { id: hidden }, take: 1 })
    ).rejects.toThrow();
  });
  it("rejects usage-counter distinct selection", async () => {
    await expect(
      scoped().automationRule.findMany({ distinct: ["triggerCount"] })
    ).rejects.toThrow();
  });
  it("rejects credential-hash relation predicates", async () => {
    await expect(
      scoped().membership.count({ where: { user: { password: { startsWith: "$2" } } } })
    ).rejects.toThrow();
  });
  it("rejects hidden platform relation predicates and relation-count ordering", async () => {
    await expect(
      scoped().membership.count({
        where: { user: { memberships: { some: { businessId: b.businessId } } } },
      })
    ).rejects.toThrow();
    await expect(
      scoped().customer.findMany({ orderBy: { conversations: { _count: "desc" } } })
    ).rejects.toThrow();
  });
  it("rejects usage-counter grouping and threshold filters", async () => {
    await expect(
      scoped().automationRule.groupBy({ by: ["triggerCount"], _count: true })
    ).rejects.toThrow();
    await expect(
      scoped().automationRule.count({ where: { triggerCount: { gte: 1 } } })
    ).rejects.toThrow();
    await expect(
      scoped().automationRule.findMany({ orderBy: { triggerCount: "desc" } })
    ).rejects.toThrow();
  });
  it("rejects foreign PrismaPromise batch transactions", async () => {
    await expect(async () =>
      scoped().$transaction([prisma.conversation.findMany({ where: { businessId: b.businessId } })])
    ).rejects.toThrow();
  });
  it("rejects raw SQL disguised as a batch transaction", async () => {
    await expect(async () =>
      scoped().$transaction([
        prisma.$queryRaw`SELECT "id" FROM "Conversation" WHERE "businessId"=${b.businessId}`,
      ])
    ).rejects.toThrow();
  });
});
