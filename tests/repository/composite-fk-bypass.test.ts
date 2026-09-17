import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";

/**
 * PLAN.md §8.4/§8.6/§33.1/§33.4 item 3 — layer 3 of the isolation stack:
 * for every relation in §8.4's table (plus the two schema-quality fixes
 * bundled into it, CallLog/Schedule per §12), this deliberately bypasses
 * the service layer AND `assertSameTenant()` (layer 4) entirely, writing
 * directly against `getScopedPrisma(ctx)`, and asserts Postgres's own
 * composite foreign-key constraint rejects the cross-tenant reference
 * regardless. This is what proves layer 3 holds even if every layer above
 * it has a bug — the literal, non-negotiable acceptance criterion added in
 * this revision (§46.2's "Acceptance criteria").
 *
 * Real Postgres required, never mocked (§34.1/§34.2) — a mock cannot
 * exercise a real database constraint at all.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let businessA: SeededBusiness;
let businessB: SeededBusiness;

beforeAll(async () => {
  businessA = await seedBusiness("fk-bypass-a");
  businessB = await seedBusiness("fk-bypass-b");
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

const FK_VIOLATION = /foreign key constraint/i;

describe("Composite foreign-key isolation — §8.4's table, bypassing assertSameTenant entirely", () => {
  it("TeamMember.departmentId cannot reference another business's Department", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const departmentA = await dbA.department.create({ data: { name: "Dept A" } });

    await expect(
      dbB.teamMember.create({
        data: { departmentId: departmentA.id, name: "Cross-tenant TM", email: "x@test.com" },
      })
    ).rejects.toThrow(FK_VIOLATION);

    const departmentB = await dbB.department.create({ data: { name: "Dept B" } });
    const sameTenant = await dbB.teamMember.create({
      data: { departmentId: departmentB.id, name: "Same-tenant TM", email: "y@test.com" },
    });
    expect(sameTenant.departmentId).toBe(departmentB.id);
  });

  it("Ticket.assignedToId cannot reference another business's TeamMember", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const departmentA = await dbA.department.create({ data: { name: "Dept A2" } });
    const teamMemberA = await dbA.teamMember.create({
      data: { departmentId: departmentA.id, name: "TM A2", email: "tma2@test.com" },
    });

    await expect(
      dbB.ticket.create({ data: { title: "t", description: "d", assignedToId: teamMemberA.id } })
    ).rejects.toThrow(FK_VIOLATION);

    const departmentB = await dbB.department.create({ data: { name: "Dept B2" } });
    const teamMemberB = await dbB.teamMember.create({
      data: { departmentId: departmentB.id, name: "TM B2", email: "tmb2@test.com" },
    });
    const sameTenant = await dbB.ticket.create({
      data: { title: "t", description: "d", assignedToId: teamMemberB.id },
    });
    expect(sameTenant.assignedToId).toBe(teamMemberB.id);
  });

  it("Ticket.departmentId cannot reference another business's Department", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const departmentA = await dbA.department.create({ data: { name: "Dept A3" } });

    await expect(
      dbB.ticket.create({ data: { title: "t", description: "d", departmentId: departmentA.id } })
    ).rejects.toThrow(FK_VIOLATION);

    const departmentB = await dbB.department.create({ data: { name: "Dept B3" } });
    const sameTenant = await dbB.ticket.create({
      data: { title: "t", description: "d", departmentId: departmentB.id },
    });
    expect(sameTenant.departmentId).toBe(departmentB.id);
  });

  it("Ticket.conversationId cannot reference another business's Conversation", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const conversationA = await dbA.conversation.create({ data: { channel: "whatsapp" } });

    await expect(
      dbB.ticket.create({ data: { title: "t", description: "d", conversationId: conversationA.id } })
    ).rejects.toThrow(FK_VIOLATION);

    const conversationB = await dbB.conversation.create({ data: { channel: "whatsapp" } });
    const sameTenant = await dbB.ticket.create({
      data: { title: "t", description: "d", conversationId: conversationB.id },
    });
    expect(sameTenant.conversationId).toBe(conversationB.id);
  });

  it("Schedule.teamMemberId cannot reference another business's TeamMember", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const departmentA = await dbA.department.create({ data: { name: "Dept A4" } });
    const teamMemberA = await dbA.teamMember.create({
      data: { departmentId: departmentA.id, name: "TM A4", email: "tma4@test.com" },
    });

    await expect(
      dbB.schedule.create({
        data: { teamMemberId: teamMemberA.id, dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
      })
    ).rejects.toThrow(FK_VIOLATION);

    const departmentB = await dbB.department.create({ data: { name: "Dept B4" } });
    const teamMemberB = await dbB.teamMember.create({
      data: { departmentId: departmentB.id, name: "TM B4", email: "tmb4@test.com" },
    });
    const sameTenant = await dbB.schedule.create({
      data: { teamMemberId: teamMemberB.id, dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
    });
    expect(sameTenant.teamMemberId).toBe(teamMemberB.id);
  });

  it("KnowledgeEntry.categoryId cannot reference another business's Category", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const categoryA = await dbA.category.create({ data: { name: "Cat A" } });

    await expect(
      dbB.knowledgeEntry.create({ data: { categoryId: categoryA.id, title: "t", content: "c" } })
    ).rejects.toThrow(FK_VIOLATION);

    const categoryB = await dbB.category.create({ data: { name: "Cat B" } });
    const sameTenant = await dbB.knowledgeEntry.create({
      data: { categoryId: categoryB.id, title: "t", content: "c" },
    });
    expect(sameTenant.categoryId).toBe(categoryB.id);
  });

  it("Message.conversationId cannot reference another business's Conversation", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const conversationA = await dbA.conversation.create({ data: { channel: "whatsapp" } });

    await expect(
      dbB.message.create({ data: { conversationId: conversationA.id, role: "customer", content: "hi" } })
    ).rejects.toThrow(FK_VIOLATION);

    const conversationB = await dbB.conversation.create({ data: { channel: "whatsapp" } });
    const sameTenant = await dbB.message.create({
      data: { conversationId: conversationB.id, role: "customer", content: "hi" },
    });
    expect(sameTenant.conversationId).toBe(conversationB.id);
  });

  it("InternalNote.conversationId cannot reference another business's Conversation", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const conversationA = await dbA.conversation.create({ data: { channel: "whatsapp" } });

    await expect(
      dbB.internalNote.create({ data: { conversationId: conversationA.id, content: "note" } })
    ).rejects.toThrow(FK_VIOLATION);

    const conversationB = await dbB.conversation.create({ data: { channel: "whatsapp" } });
    const sameTenant = await dbB.internalNote.create({
      data: { conversationId: conversationB.id, content: "note" },
    });
    expect(sameTenant.conversationId).toBe(conversationB.id);
  });

  it("ConversationTag.conversationId cannot reference another business's Conversation", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const conversationA = await dbA.conversation.create({ data: { channel: "whatsapp" } });
    const tagB = await dbB.tag.create({ data: { name: `tag-b-${crypto.randomUUID()}` } });

    await expect(
      dbB.conversationTag.create({ data: { conversationId: conversationA.id, tagId: tagB.id } })
    ).rejects.toThrow(FK_VIOLATION);

    const conversationB = await dbB.conversation.create({ data: { channel: "whatsapp" } });
    const sameTenant = await dbB.conversationTag.create({
      data: { conversationId: conversationB.id, tagId: tagB.id },
    });
    expect(sameTenant.conversationId).toBe(conversationB.id);
  });

  it("ConversationTag.tagId cannot reference another business's Tag", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const tagA = await dbA.tag.create({ data: { name: `tag-a-${crypto.randomUUID()}` } });
    const conversationB = await dbB.conversation.create({ data: { channel: "whatsapp" } });

    await expect(
      dbB.conversationTag.create({ data: { conversationId: conversationB.id, tagId: tagA.id } })
    ).rejects.toThrow(FK_VIOLATION);

    const tagB = await dbB.tag.create({ data: { name: `tag-b2-${crypto.randomUUID()}` } });
    const sameTenant = await dbB.conversationTag.create({
      data: { conversationId: conversationB.id, tagId: tagB.id },
    });
    expect(sameTenant.tagId).toBe(tagB.id);
  });

  it("Conversation.customerId cannot reference another business's Customer", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const customerA = await dbA.customer.create({ data: { name: "Cust A" } });

    await expect(
      dbB.conversation.create({ data: { channel: "whatsapp", customerId: customerA.id } })
    ).rejects.toThrow(FK_VIOLATION);

    const customerB = await dbB.customer.create({ data: { name: "Cust B" } });
    const sameTenant = await dbB.conversation.create({
      data: { channel: "whatsapp", customerId: customerB.id },
    });
    expect(sameTenant.customerId).toBe(customerB.id);
  });

  it("CustomerNote.customerId cannot reference another business's Customer", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const customerA = await dbA.customer.create({ data: { name: "Cust A2" } });

    await expect(
      dbB.customerNote.create({ data: { customerId: customerA.id, content: "note" } })
    ).rejects.toThrow(FK_VIOLATION);

    const customerB = await dbB.customer.create({ data: { name: "Cust B2" } });
    const sameTenant = await dbB.customerNote.create({
      data: { customerId: customerB.id, content: "note" },
    });
    expect(sameTenant.customerId).toBe(customerB.id);
  });

  it("CallLog.conversationId cannot reference another business's Conversation (§2.8 schema-quality fix bundled into §8.4)", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const conversationA = await dbA.conversation.create({ data: { channel: "phone" } });

    await expect(
      dbB.callLog.create({
        data: {
          conversationId: conversationA.id,
          callSid: `CA-bypass-${crypto.randomUUID()}`,
          from: "+15550000000",
          to: "+15550000001",
        },
      })
    ).rejects.toThrow(FK_VIOLATION);

    const conversationB = await dbB.conversation.create({ data: { channel: "phone" } });
    const sameTenant = await dbB.callLog.create({
      data: {
        conversationId: conversationB.id,
        callSid: `CA-ok-${crypto.randomUUID()}`,
        from: "+15550000000",
        to: "+15550000001",
      },
    });
    expect(sameTenant.conversationId).toBe(conversationB.id);
  });

  it("WebhookDelivery.webhookId cannot reference another business's Webhook", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);

    const webhookA = await dbA.webhook.create({
      data: { name: "WH A", url: "https://example.com/hook", triggerOn: "ticket_created" },
    });

    await expect(
      dbB.webhookDelivery.create({ data: { webhookId: webhookA.id, event: "test", payload: {} } })
    ).rejects.toThrow(FK_VIOLATION);

    const webhookB = await dbB.webhook.create({
      data: { name: "WH B", url: "https://example.com/hook", triggerOn: "ticket_created" },
    });
    const sameTenant = await dbB.webhookDelivery.create({
      data: { webhookId: webhookB.id, event: "test", payload: {} },
    });
    expect(sameTenant.webhookId).toBe(webhookB.id);
  });
});
