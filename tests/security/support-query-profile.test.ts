import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { retirementContext } from "@/lib/tenancy/work-lifecycle";
import type { TenantContext } from "@/lib/tenancy/context";

// Controlled trusted-context prerequisite; this suite proves repository query
// restrictions, not fresh session/platform/grant admission or exposure auditing.
type ProfileContext = TenantContext & { supportQuery?: unknown };
let a: SeededBusiness, b: SeededBusiness;
let connections: string[], rows: Array<{ id: string; customerName: string }>;
const profile = {
  method: "GET",
  pathname: "/api/conversations",
  operation: "conversations:read",
} as const;
const select = { id: true, channel: true, status: true, customerName: true };
const list = { select, take: 20, skip: 0, orderBy: { updatedAt: "desc" as const } };
beforeEach(async () => {
  a = await seedBusiness("support-query-a");
  b = await seedBusiness("support-query-b");
  connections = [];
  for (const suffix of ["visible", "excluded"]) {
    const connection = await prisma.channelConnection.create({
      data: {
        businessId: a.businessId,
        type: "webchat",
        name: suffix,
        isActive: true,
        credentialRef: "synthetic-private-credential",
        config: { privateValue: "synthetic-private-config" },
      },
    });
    connections.push(connection.id);
  }
  rows = [];
  for (let i = 0; i < 3; i++)
    rows.push(
      await prisma.conversation.create({
        data: {
          businessId: a.businessId,
          channel: "webchat",
          customerName: i === 0 ? "Visible visitor" : "Excluded visitor",
          customerContact: "synthetic-contact",
          summary: "synthetic-private-summary",
          metadata: i < 2 ? { channelConnectionId: connections[i] } : {},
        },
      })
    );
  await prisma.conversation.create({
    data: { businessId: b.businessId, channel: "webchat", customerName: "Foreign visitor" },
  });
  await prisma.businessConfig.upsert({
    where: { businessId: a.businessId },
    create: { businessId: a.businessId, aiCredentialRef: "synthetic-private-ai-ref" },
    update: { aiCredentialRef: "synthetic-private-ai-ref" },
  });
});
afterEach(async () => {
  await cleanupBusiness(a.businessId);
  await cleanupBusiness(b.businessId);
  await prisma.user.deleteMany({ where: { id: { in: [a.ownerUserId, b.ownerUserId] } } });
});
function support(workspace = false): ProfileContext {
  return {
    businessId: a.businessId,
    role: null,
    dataConnection: "shared-default",
    actor: { kind: "platform_admin", userId: a.ownerUserId },
    authorization: {
      kind: "support",
      userId: a.ownerUserId,
      grantId: randomUUID(),
      allowedOperations: ["conversations:read"],
    },
    resourceScope: workspace
      ? { kind: "workspace", customerProfileAccess: "write" }
      : { kind: "connections", connectionIds: [connections[0]], customerProfileAccess: "none" },
    supportQuery: { ...profile },
  };
}
const denied = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ statusCode: 403 });
describe("P1 support scalar conversation query profile, real isolated Postgres", () => {
  it("lists/counts only the named connection with explicit scalar projection", async () => {
    const db = getScopedPrisma(support());
    expect(await db.conversation.findMany(list)).toEqual([
      { id: rows[0].id, channel: "webchat", status: "active", customerName: "Visible visitor" },
    ]);
    expect(await db.conversation.count({ where: {} })).toBe(1);
    expect(await db.conversation.findMany({ ...list, where: { id: rows[1].id } })).toEqual([]);
    expect(
      await db.conversation.count({
        where: { OR: [{ customerName: { contains: "Excluded" } }, { businessId: b.businessId }] },
      })
    ).toBe(0);
  });
  it.each([
    "businessConfig",
    "channelConnection",
    "apiKey",
    "membership",
    "toolPolicy",
    "actionExecution",
    "deliveryOperation",
    "campaign",
    "knowledgeEntry",
    "customer",
    "message",
    "ticket",
    "activityLog",
  ] as const)("denies full-workspace support root %s", async (model) => {
    await denied(getScopedPrisma(support(true))[model].findMany());
  });
  it("requires explicit safe projection and bounded pagination", async () => {
    const db = getScopedPrisma(support(true));
    for (const args of [
      {},
      { take: 20 },
      { select, take: 101 },
      { select, take: -1 },
      { select, take: 20, skip: -1 },
      { select: { id: true, metadata: true }, take: 20 },
      { select: { id: true, summary: true }, take: 20 },
      { select: { id: true, satisfaction: true }, take: 20 },
      { omit: { summary: true }, take: 20 },
    ])
      await denied(db.conversation.findMany(args));
  });
  it("denies relations, nested counts, relation predicates/orderings and arbitrary aggregation", async () => {
    const db = getScopedPrisma(support(true));
    for (const args of [
      { ...list, include: { messages: true } },
      { ...list, select: { id: true, customer: true } },
      { ...list, select: { id: true, tickets: true } },
      { ...list, select: { id: true, _count: true } },
      { ...list, where: { messages: { some: { content: { contains: "private" } } } } },
      { ...list, where: { OR: [{ id: rows[0].id }, { customer: { is: { name: "private" } } }] } },
      { ...list, orderBy: { messages: { _count: "desc" } } },
      { ...list, cursor: { id: rows[1].id } },
    ])
      await denied(db.conversation.findMany(args as never));
    await denied(db.conversation.count({ select: { _all: true, summary: true } }));
    await denied(db.conversation.aggregate({ _count: true }));
    await denied(db.conversation.groupBy({ by: ["status"], _count: true }));
    await denied(db.conversation.findUnique({ where: { id: rows[0].id }, select }));
  });
  it("denies every mutation, including a guarded transaction and a retirement wrapper", async () => {
    const db = getScopedPrisma(support(true));
    await denied(db.conversation.update({ where: { id: rows[0].id }, data: { status: "closed" } }));
    await denied(db.conversation.updateMany({ where: {}, data: { status: "closed" } }));
    await denied(
      db.conversation.create({ data: { businessId: a.businessId, channel: "webchat" } })
    );
    await denied(db.$transaction(async (tx) => tx.businessConfig.findMany()));
    await denied(
      getScopedPrisma(retirementContext(support(true))).conversation.delete({
        where: { id: rows[0].id },
      })
    );
    expect(
      (await prisma.conversation.findUniqueOrThrow({ where: { id: rows[0].id } })).status
    ).toBe("active");
  });
  it("denies wrong or missing request profiles, actors, scope and operation", async () => {
    const base = support(true);
    for (const ctx of [
      { ...base, supportQuery: undefined },
      { ...base, supportQuery: { ...profile, method: "POST" } },
      { ...base, supportQuery: { ...profile, pathname: "/api/conversations/guessed" } },
      { ...base, supportQuery: { ...profile, operation: "messages:read" } },
      { ...base, role: "owner" },
      { ...base, authorization: undefined },
      { ...base, authorization: { ...base.authorization, kind: "support", userId: randomUUID() } },
      { ...base, actor: { kind: "user", userId: a.ownerUserId } },
      {
        ...base,
        authorization: {
          ...base.authorization,
          kind: "support",
          allowedOperations: ["messages:read"],
        },
      },
    ])
      await denied(getScopedPrisma(ctx as TenantContext).conversation.findMany(list));
    expect(() => getScopedPrisma({ ...base, resourceScope: undefined })).toThrow();
  });
  it("denies copied support provenance on autonomous or delegated actors", async () => {
    const base = support(true);
    for (const actor of [
      { kind: "ai_agent", conversationId: rows[0].id, model: "stand-in" },
      { kind: "system_job", jobId: randomUUID(), jobType: "send-followup" },
    ]) {
      await denied(
        getScopedPrisma({ ...base, actor } as TenantContext).conversation.findMany(list)
      );
      await denied(
        getScopedPrisma({
          ...base,
          actor,
          authorization: {
            kind: "delegated_job",
            allowedOperations: ["messages:create"],
            origin: base.authorization,
          },
        } as TenantContext).conversation.findMany(list)
      );
    }
  });
  it("rejects matching missing actor and support user IDs instead of treating undefined as identity", async () => {
    const base = support(true);
    const broken = {
      ...base,
      actor: { kind: "platform_admin", userId: undefined },
      authorization: { ...base.authorization, kind: "support", userId: undefined },
    } as unknown as TenantContext;
    await denied(getScopedPrisma(broken).conversation.findMany(list));
  });
  it("permits the explicit workspace list while excluding retired and foreign conversations", async () => {
    const db = getScopedPrisma(support(true));
    expect(await db.conversation.count()).toBe(3);
    await prisma.conversation.update({
      where: { id: rows[1].id },
      data: { retiredAt: new Date() },
    });
    expect(await db.conversation.count()).toBe(2);
    const visible = await db.conversation.findMany(list);
    expect(visible.map((row) => row.id).sort()).toEqual([rows[0].id, rows[2].id].sort());
    expect(JSON.stringify(visible)).not.toContain("synthetic-private");
  });
  it("denies private-field references as scalar predicate operands", async () => {
    await prisma.conversation.update({
      where: { id: rows[0].id },
      data: { customerName: "synthetic-private-summary" },
    });
    const db = getScopedPrisma(support());
    await denied(
      db.conversation.count({
        where: { customerName: { equals: prisma.conversation.fields.summary } },
      })
    );
    await denied(
      db.conversation.count({
        where: { customerName: { not: { equals: prisma.conversation.fields.summary } } },
      })
    );
  });
  it("denies transitive copied support provenance without a request profile", async () => {
    const base = support(true);
    const copied = {
      ...base,
      supportQuery: undefined,
      actor: { kind: "system_job", jobId: randomUUID(), jobType: "send-followup" },
      authorization: {
        kind: "delegated_job",
        allowedOperations: ["messages:create"],
        origin: {
          kind: "delegated_job",
          allowedOperations: ["messages:create"],
          origin: base.authorization,
        },
      },
    } as unknown as TenantContext;
    await denied(getScopedPrisma(copied).businessConfig.findMany());
  });
  it("keeps allowed list reads scoped inside guarded transaction callbacks", async () => {
    const db = getScopedPrisma(support());
    const result = await db.$transaction(async (tx) => tx.conversation.findMany(list));
    expect(result.map((row) => row.id)).toEqual([rows[0].id]);
    await denied(
      db.$transaction(async (tx) =>
        tx.conversation.update({ where: { id: rows[0].id }, data: { status: "closed" } })
      )
    );
  });
  it("keeps inherited pagination bounded after Prisma canonicalizes arguments", async () => {
    const args = Object.assign(Object.create({ take: 1 }), { select });
    expect(await getScopedPrisma(support(true)).conversation.findMany(args)).toHaveLength(1);
  });
  it("validates the same getter-provided ordering that reaches Prisma", async () => {
    let reads = 0;
    const args = { select, take: 20 };
    Object.defineProperty(args, "orderBy", {
      enumerable: true,
      get: () => (++reads === 1 ? { summary: "desc" } : { updatedAt: "desc" }),
    });
    await denied(getScopedPrisma(support(true)).conversation.findMany(args));
  });
  it("preserves ordinary member query and mutation behavior", async () => {
    const db = getScopedPrisma(a.ctx);
    expect(await db.conversation.count()).toBe(3);
    expect(
      await db.businessConfig.findUnique({ where: { businessId: a.businessId } })
    ).toMatchObject({ aiCredentialRef: "synthetic-private-ai-ref" });
    expect(
      await db.conversation.update({ where: { id: rows[0].id }, data: { status: "closed" } })
    ).toMatchObject({ status: "closed" });
  });
});
