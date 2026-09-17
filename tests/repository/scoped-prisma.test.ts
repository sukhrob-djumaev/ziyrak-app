import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";

/**
 * PLAN.md §34.1 — "the single most safety-critical piece of code in the
 * whole plan": a dedicated suite that seeds two businesses' worth of every
 * tenant-owned model and exhaustively asserts the extension's
 * findMany/findUnique/create/update/delete behavior. Real Postgres
 * required, never mocked (§34.2) — mocking Prisma here would test the
 * mock's behavior, not the extension's or the database's actual behavior.
 *
 * Unmocks "@/lib/prisma/raw-client" the same way
 * tests/security/auth-bypass-regression.test.ts unmocks "@/lib/route-auth"
 * — every other test file keeps using the fast in-memory mock from
 * tests/setup.ts; only this suite (and composite-fk-bypass.test.ts) needs
 * the real thing.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { getScopedPrisma, TENANT_SCOPED_MODELS, CrossTenantWriteError } from "@/lib/tenancy/scoped-prisma";
import { runWithTenantContext } from "@/lib/tenancy/context";
import { prisma as rawClient } from "@/lib/prisma/raw-client";
import { hashPassword } from "@/lib/auth";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let businessA: SeededBusiness;
let businessB: SeededBusiness;

beforeAll(async () => {
  businessA = await seedBusiness("scoped-prisma-a");
  businessB = await seedBusiness("scoped-prisma-b");
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

describe("getScopedPrisma() — core CRUD scoping (§8.3)", () => {
  it("findMany only returns the caller's own business's rows", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    await dbA.category.create({ data: { name: "A-only category" } });
    await dbB.category.create({ data: { name: "B-only category" } });

    const seenByA = await dbA.category.findMany({});
    expect(seenByA.every((c) => c.businessId === businessA.businessId)).toBe(true);
    expect(seenByA.some((c) => c.name === "B-only category")).toBe(false);
  });

  it("findUnique returns null for another business's row by a known real id", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const customerB = await dbB.customer.create({ data: { name: "B's customer" } });

    const result = await dbA.customer.findUnique({ where: { id: customerB.id } });
    expect(result).toBeNull();
  });

  it("findFirst is scoped even when the caller supplies a different businessId in `where`", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const customerB = await dbB.customer.create({ data: { name: "spoof-attempt-target" } });

    // An attacker-controlled where.businessId must never win over ctx's own.
    const result = await dbA.customer.findFirst({
      where: { id: customerB.id, businessId: businessB.businessId },
    });
    expect(result).toBeNull();
  });

  it("count only counts the caller's own rows", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const beforeA = await dbA.tag.count({});
    await dbA.tag.create({ data: { name: `count-tag-${crypto.randomUUID()}` } });
    await dbB.tag.create({ data: { name: `count-tag-${crypto.randomUUID()}` } });
    const afterA = await dbA.tag.count({});

    expect(afterA).toBe(beforeA + 1);
  });

  it("create silently tags a payload with no businessId as the caller's own", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const category = await dbA.category.create({ data: { name: "auto-tagged" } });
    expect(category.businessId).toBe(businessA.businessId);
  });

  it("create allows a payload that names the SAME businessId as ctx (idempotent)", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const category = await dbA.category.create({
      data: { name: "same-business-ok", businessId: businessA.businessId },
    });
    expect(category.businessId).toBe(businessA.businessId);
  });

  it("create REJECTS a payload that names a different businessId (§8.3)", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    await expect(
      dbA.category.create({ data: { name: "cross-tenant-attempt", businessId: businessB.businessId } })
    ).rejects.toThrow(CrossTenantWriteError);
  });

  it("update cannot modify another business's row by known id", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const categoryB = await dbB.category.create({ data: { name: "untouched" } });

    await expect(
      dbA.category.update({ where: { id: categoryB.id }, data: { name: "hacked" } })
    ).rejects.toThrow();

    const stillUnchanged = await dbB.category.findUnique({ where: { id: categoryB.id } });
    expect(stillUnchanged?.name).toBe("untouched");
  });

  it("delete cannot delete another business's row by known id", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const categoryB = await dbB.category.create({ data: { name: "must-survive" } });

    await expect(dbA.category.delete({ where: { id: categoryB.id } })).rejects.toThrow();

    const stillExists = await dbB.category.findUnique({ where: { id: categoryB.id } });
    expect(stillExists).not.toBeNull();
  });

  it("updateMany/deleteMany only ever affect the caller's own rows", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const marker = `bulk-${crypto.randomUUID()}`;
    await dbA.cannedResponse.create({ data: { title: marker, content: "x" } });
    await dbB.cannedResponse.create({ data: { title: marker, content: "x" } });

    const updateResult = await dbA.cannedResponse.updateMany({
      where: { title: marker },
      data: { content: "updated-by-a" },
    });
    expect(updateResult.count).toBe(1);

    const bRow = await dbB.cannedResponse.findFirst({ where: { title: marker } });
    expect(bRow?.content).toBe("x");
  });

  it("upsert is scoped in both the lookup (where) and the create branch", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const shortcut = `upsert-${crypto.randomUUID()}`;
    await dbB.cannedResponse.create({ data: { title: "B's row", content: "b", shortcut } });

    // A's upsert must not find B's row (different businessId), so it creates
    // its own instead of updating B's.
    const result = await dbA.cannedResponse.upsert({
      where: { id: crypto.randomUUID() }, // won't match anything real
      create: { title: "A's row", content: "a", shortcut: `${shortcut}-a` },
      update: { content: "should-not-apply" },
    });
    expect(result.businessId).toBe(businessA.businessId);

    const bRowStillIntact = await dbB.cannedResponse.findFirst({ where: { shortcut } });
    expect(bRowStillIntact?.content).toBe("b");
  });
});

describe("getScopedPrisma() — fail-closed / AsyncLocalStorage backstop (§8.2)", () => {
  it("throws synchronously when called with no ctx and no ambient backstop", () => {
    expect(() => getScopedPrisma(undefined)).toThrow(/no TenantContext/i);
  });

  it("falls back to the AsyncLocalStorage-provided context when ctx is omitted (backstop only, §8.2c)", async () => {
    const category = await runWithTenantContext(businessA.ctx, async () => {
      const db = getScopedPrisma(undefined);
      return db.category.create({ data: { name: "via-backstop" } });
    });

    expect(category.businessId).toBe(businessA.businessId);
  });
});

/**
 * Minimal valid `data` for a `create` call per tenant-scoped model, given a
 * seeded business. Some models need a same-tenant parent row created first
 * (department → teamMember → schedule; category → knowledgeEntry;
 * conversation → message/internalNote; conversation+tag → conversationTag;
 * webhook → webhookDelivery; customer → customerNote). Returns the created
 * row so `businessId` can be asserted on uniformly.
 */
async function createMinimalRow(
  model: (typeof TENANT_SCOPED_MODELS)[number],
  db: ReturnType<typeof getScopedPrisma>,
  marker: string
): Promise<{ businessId: string }> {
  switch (model) {
    case "membership": {
      const passwordHash = await hashPassword("not-a-real-login-password");
      const user = await rawClient.user.create({
        data: { username: `membership-${marker}`, password: passwordHash, name: marker },
      });
      return db.membership.create({ data: { userId: user.id, role: "viewer" } });
    }
    case "customer":
      return db.customer.create({ data: { name: marker } });
    case "category":
      return db.category.create({ data: { name: marker } });
    case "tag":
      return db.tag.create({ data: { name: marker } });
    case "webhook":
      return db.webhook.create({ data: { name: marker, url: "https://example.com/hook", triggerOn: "ticket_created" } });
    case "activityLog":
      return db.activityLog.create({ data: { action: marker, entity: "test", description: marker } });
    case "sLARule":
      return db.sLARule.create({ data: { name: marker } });
    case "cannedResponse":
      return db.cannedResponse.create({ data: { title: marker, content: "x" } });
    case "automationRule":
      return db.automationRule.create({ data: { name: marker, type: "auto_tag" } });
    case "campaign":
      return db.campaign.create({ data: { name: marker, message: "hi" } });
    case "flow":
      return db.flow.create({ data: { name: marker } });
    case "department":
      return db.department.create({ data: { name: marker } });
    case "channelConnection":
      return db.channelConnection.create({ data: { type: "whatsapp", name: marker } });
    case "apiKey":
      return db.apiKey.create({ data: { name: marker, keyPrefix: marker.slice(0, 16), keyHash: marker } });
    case "conversation":
      return db.conversation.create({ data: { channel: "whatsapp", customerName: marker } });
    case "ticket":
      return db.ticket.create({ data: { title: marker, description: marker } });
    case "businessConfig":
      return db.businessConfig.create({ data: { businessName: marker } });
    case "businessHours":
      // id defaults to the literal string "default" (§13.2.9's backfill-in-place
      // note) — only safe for one row system-wide unless given an explicit id.
      return db.businessHours.create({ data: { id: crypto.randomUUID() } });
    case "knowledgeEntry": {
      const category = await db.category.create({ data: { name: `${marker}-cat` } });
      return db.knowledgeEntry.create({
        data: { categoryId: category.id, title: marker, content: marker },
      });
    }
    case "teamMember": {
      const department = await db.department.create({ data: { name: `${marker}-dept` } });
      return db.teamMember.create({
        data: { departmentId: department.id, name: marker, email: `${marker}@example.com` },
      });
    }
    case "schedule": {
      const department = await db.department.create({ data: { name: `${marker}-dept` } });
      const teamMember = await db.teamMember.create({
        data: { departmentId: department.id, name: marker, email: `${marker}@example.com` },
      });
      return db.schedule.create({
        data: { teamMemberId: teamMember.id, dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
      });
    }
    case "message": {
      const conversation = await db.conversation.create({ data: { channel: "whatsapp", customerName: marker } });
      return db.message.create({ data: { conversationId: conversation.id, role: "customer", content: marker } });
    }
    case "internalNote": {
      const conversation = await db.conversation.create({ data: { channel: "whatsapp", customerName: marker } });
      return db.internalNote.create({ data: { conversationId: conversation.id, content: marker } });
    }
    case "conversationTag": {
      const conversation = await db.conversation.create({ data: { channel: "whatsapp", customerName: marker } });
      const tag = await db.tag.create({ data: { name: `${marker}-tag` } });
      return db.conversationTag.create({ data: { conversationId: conversation.id, tagId: tag.id } });
    }
    case "callLog":
      return db.callLog.create({ data: { callSid: `CA${marker}`, from: "+15550000000", to: "+15550000001" } });
    case "webhookDelivery": {
      const webhook = await db.webhook.create({
        data: { name: `${marker}-wh`, url: "https://example.com/hook", triggerOn: "ticket_created" },
      });
      return db.webhookDelivery.create({ data: { webhookId: webhook.id, event: "test", payload: {} } });
    }
    case "customerNote": {
      const customer = await db.customer.create({ data: { name: `${marker}-cust` } });
      return db.customerNote.create({ data: { customerId: customer.id, content: marker } });
    }
  }
}

describe("getScopedPrisma() — exhaustive per-model businessId scoping (§8.3 TENANT_SCOPED_MODELS)", () => {
  it.each(TENANT_SCOPED_MODELS)("%s: a row created for one business never appears in the other's findMany", async (model) => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);
    const marker = `${model}-${crypto.randomUUID()}`;

    const rowA = await createMinimalRow(model, dbA, `${marker}-a`);
    const rowB = await createMinimalRow(model, dbB, `${marker}-b`);

    expect(rowA.businessId).toBe(businessA.businessId);
    expect(rowB.businessId).toBe(businessB.businessId);

    const modelClient = dbA[model] as { findMany: (args: Record<string, never>) => Promise<Array<{ businessId: string }>> };
    const seenByA = await modelClient.findMany({});
    expect(seenByA.every((r) => r.businessId === businessA.businessId)).toBe(true);
    expect(seenByA.some((r) => r.businessId === businessB.businessId)).toBe(false);
  });
});
