import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import crypto from "crypto";

/**
 * PLAN.md §46.7 task 4 — "confirm create_ticket, assign_to_person,
 * get_customer_history, schedule_followup, trigger_webhook all function
 * correctly end-to-end for a freshly-signed-up business with no pre-seeded
 * data (graceful behavior with empty Department/TeamMember tables), and that
 * default ToolPolicy rows are seeded correctly for a new business."
 *
 * Real Postgres throughout. The business is created by the production
 * provisioning path (`platform/provisioning.ts`) — not seeded by hand — and a
 * *second, fully-populated* business exists alongside it so any accidental
 * fallback to "some other tenant's data" would be visible as a wrong result.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

const dispatchMock = vi.fn();
vi.mock("@/lib/integrations/http-dispatcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/http-dispatcher")>();
  return { ...actual, dispatchHttpRequest: (...args: Parameters<typeof actual.dispatchHttpRequest>) => dispatchMock(...args) };
});

import { prisma } from "@/lib/prisma/raw-client";
import { toolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/builtin";
import { DEFAULT_TOOL_POLICIES } from "@/lib/tools/policy";
import { provisionBusiness } from "@/lib/platform/provisioning";
import { jobQueue } from "@/lib/jobs/queue";
import type { FakeJobQueue } from "@/lib/jobs/fake-job-queue";
import "@/lib/jobs/bootstrap";
import "@/lib/channels/webchat-adapter";
import { createWebChatConnection } from "@/lib/channels/webchat-connections-service";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import type { TenantContext } from "@/lib/tenancy/context";
import { SSRFBlockedError } from "@/lib/integrations/http-dispatcher";

let fresh: { businessId: string; userId: string };
let other: SeededBusiness;
const suffix = crypto.randomBytes(4).toString("hex");

function ai(conversationId = "conv"): TenantContext {
  return { businessId: fresh.businessId, role: null, actor: { kind: "ai_agent", conversationId, model: "fake" }, dataConnection: "shared-default" };
}
function human(role: string): TenantContext {
  return { businessId: fresh.businessId, role, actor: { kind: "user", userId: fresh.userId }, dataConnection: "shared-default" };
}
let toolCall = 0;
const call = (ctx: TenantContext, tool: string, args: unknown, conversationId?: string) =>
  toolRegistry.execute(ctx, tool, args, { toolCallId: `fresh-${suffix}-${++toolCall}`, conversationId });

beforeAll(async () => {
  const provisioned = await provisionBusiness({ businessName: `Fresh ${suffix}`, ownerUsername: `fresh-${suffix}`, ownerPassword: "a-decent-password" });
  fresh = { businessId: provisioned.businessId, userId: provisioned.userId };

  // A populated neighbor: team, department, customer history, webhook, tickets.
  other = await seedBusiness("fresh-neighbor");
  const dept = await prisma.department.create({ data: { businessId: other.businessId, name: "Billing Dept" } });
  await prisma.teamMember.create({ data: { businessId: other.businessId, departmentId: dept.id, name: "Neighbor Agent", email: "n@example.com", expertise: "billing", isAvailable: true } });
  await prisma.webhook.create({ data: { businessId: other.businessId, name: "crm-hook", url: "https://crm.example.com/hook", triggerOn: "ticket.created", isActive: true } });
  await prisma.conversation.create({ data: { businessId: other.businessId, channel: "sms", customerName: "Shared Number", customerContact: "+15557770000" } });
});

afterAll(async () => {
  await cleanupBusiness(fresh.businessId);
  await cleanupBusiness(other.businessId);
  const memberships = await prisma.membership.findMany({ where: { businessId: fresh.businessId } }).catch(() => []);
  for (const m of memberships) await prisma.user.delete({ where: { id: m.userId } }).catch(() => {});
});

describe("default ToolPolicy for a brand-new business (§23.4/§46.7)", () => {
  it("has a complete, correct row for every real tool, and the registry honors them", async () => {
    const rows = await prisma.toolPolicy.findMany({ where: { businessId: fresh.businessId } });
    expect(rows.map((r) => r.tool).sort()).toEqual(["assign_to_person", "create_ticket", "get_customer_history", "schedule_followup", "send_internal_email", "trigger_webhook"]);
    for (const row of rows) {
      expect(row.allowedForAI).toBe(true);
      expect(row.requiresHumanApproval).toBe(false);
      expect(row.enabledForTenant).toBe(true);
      expect(row.allowedForHumanRoles).toEqual(DEFAULT_TOOL_POLICIES[row.tool].allowedForHumanRoles);
    }

    const available = (await toolRegistry.getAvailableTools(ai())).map((t) => t.name).sort();
    expect(available).toEqual(["assign_to_person", "create_ticket", "get_customer_history", "schedule_followup", "send_internal_email", "trigger_webhook"]);
    // The synthetic approval-test tool is registered but never offered to a real tenant's AI.
    expect(available).not.toContain("noop_test_action");
  });

  it("a business's own edit to its rows takes effect (rows, not code defaults, are authoritative)", async () => {
    await prisma.toolPolicy.update({ where: { businessId_tool: { businessId: fresh.businessId, tool: "send_internal_email" } }, data: { allowedForAI: false } });
    expect((await toolRegistry.getAvailableTools(ai())).map((t) => t.name)).not.toContain("send_internal_email");
    // ...and it is scoped: the neighbor is unaffected.
    const neighborAi: TenantContext = { businessId: other.businessId, role: null, actor: { kind: "ai_agent", conversationId: "c", model: "m" }, dataConnection: "shared-default" };
    expect((await toolRegistry.getAvailableTools(neighborAi)).map((t) => t.name)).toContain("send_internal_email");
    await prisma.toolPolicy.update({ where: { businessId_tool: { businessId: fresh.businessId, tool: "send_internal_email" } }, data: { allowedForAI: true } });
  });

  it("human RBAC and ToolPolicy stay independent: an agent can create tickets but not trigger webhooks", async () => {
    const agent = (await toolRegistry.getAvailableTools(human("agent"))).map((t) => t.name);
    expect(agent).toContain("create_ticket");
    expect(agent).not.toContain("trigger_webhook");
    expect((await toolRegistry.getAvailableTools(human("owner"))).map((t) => t.name)).toContain("trigger_webhook");
  });
});

describe("MVP tools against a business with no data (§46.7 task 4)", () => {
  it("create_ticket works with no departments, ignoring an unknown department name instead of failing", async () => {
    const result = await call(ai(), "create_ticket", { title: "Broken kettle", description: "It leaks", priority: "high", department: "Support" });
    expect(result).toMatchObject({ success: true, status: "succeeded" });
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { businessId: fresh.businessId, title: "Broken kettle" } });
    expect(ticket.departmentId).toBeNull();
    expect(ticket.assignedToId).toBeNull();
  });

  it("assign_to_person with zero team members fails gracefully, leaves the ticket unassigned, and never borrows another tenant's team", async () => {
    const created = await call(ai(), "create_ticket", { title: "Invoice question", description: "Overcharged", priority: "medium" });
    const ticketId = (created.data as { ticketId: string }).ticketId;

    // The neighbor has an available "billing" member; this business must not see them.
    const result = await call(ai(), "assign_to_person", { ticketId, expertise: "billing" });
    expect(result).toMatchObject({ success: false, status: "failed" });
    expect(result.message).toContain("No available team member");
    expect(result.message).not.toContain("Neighbor");

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.assignedToId).toBeNull();
    expect(ticket.status).toBe("open");
    const record = await prisma.actionExecution.findFirstOrThrow({ where: { businessId: fresh.businessId, tool: "assign_to_person" } });
    expect(record.status).toBe("failed");
  });

  it("assign_to_person works once the business has added a team member, and cannot touch another tenant's ticket", async () => {
    const dept = await prisma.department.create({ data: { businessId: fresh.businessId, name: "Support" } });
    const member = await prisma.teamMember.create({ data: { businessId: fresh.businessId, departmentId: dept.id, name: "First Hire", email: "hire@example.com", expertise: "kettles", isAvailable: true } });
    const created = await call(ai(), "create_ticket", { title: "Kettle", description: "x", priority: "low", department: "Support" });
    const ticketId = (created.data as { ticketId: string }).ticketId;

    const assigned = await call(ai(), "assign_to_person", { ticketId, expertise: "kettles" });
    expect(assigned).toMatchObject({ success: true, status: "succeeded" });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).assignedToId).toBe(member.id);

    const foreignTicket = await prisma.ticket.create({ data: { businessId: other.businessId, title: "Neighbor ticket", description: "x" } });
    const cross = await call(ai(), "assign_to_person", { ticketId: foreignTicket.id, expertise: "kettles" });
    expect(cross.success).toBe(false);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: foreignTicket.id } })).assignedToId).toBeNull();
  });

  it("get_customer_history with no customers returns an empty history, and does not surface another tenant's conversations for the same contact", async () => {
    const result = await call(ai(), "get_customer_history", { customerContact: "+15557770000" });
    expect(result).toMatchObject({ success: true, status: "succeeded", data: { history: [] } });
  });

  it("trigger_webhook with no webhooks configured fails gracefully, and cannot fire another tenant's webhook by name", async () => {
    dispatchMock.mockClear();
    const result = await call(ai(), "trigger_webhook", { webhookName: "crm-hook" });
    expect(result).toMatchObject({ success: false, status: "failed" });
    expect(result.message).toContain("No active webhook");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("trigger_webhook works for the business's own webhook, and an SSRF-blocked target fails cleanly", async () => {
    await prisma.webhook.create({ data: { businessId: fresh.businessId, name: "my-crm", url: "https://hooks.example.com/x", triggerOn: "ticket.created", isActive: true } });
    dispatchMock.mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" });
    const ok = await call(ai(), "trigger_webhook", { webhookName: "my-crm", data: { a: 1 } });
    expect(ok).toMatchObject({ success: true, status: "succeeded" });
    expect(dispatchMock).toHaveBeenCalledWith("https://hooks.example.com/x", expect.objectContaining({ method: "POST" }));

    await prisma.webhook.create({ data: { businessId: fresh.businessId, name: "internal", url: "http://169.254.169.254/latest", triggerOn: "x", isActive: true } });
    dispatchMock.mockRejectedValueOnce(new SSRFBlockedError("blocked address"));
    const blocked = await call(ai(), "trigger_webhook", { webhookName: "internal" });
    expect(blocked).toMatchObject({ success: false, status: "failed" });
  });

  it("schedule_followup fails honestly with no connection for the channel, then works durably for a fresh Web Chat business", async () => {
    const visitor = crypto.randomUUID();
    const conversation = await prisma.conversation.create({ data: { businessId: fresh.businessId, channel: "webchat", customerName: "Visitor", customerContact: visitor } });

    const before = await call(ai(conversation.id), "schedule_followup", { conversationId: conversation.id, message: "Checking in", delayHours: 0 }, conversation.id);
    expect(before).toMatchObject({ success: false, status: "failed" });
    expect(before.message).toContain("No active webchat connection");

    const connection = await createWebChatConnection(human("owner"), { allowedOrigins: ["https://shop.example.com"] });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { metadata: { channelConnectionId: connection.connectionId } } });

    const scheduled = await call(ai(conversation.id), "schedule_followup", { conversationId: conversation.id, message: "Checking in", delayHours: 0 }, conversation.id);
    expect(scheduled).toMatchObject({ success: true, status: "scheduled" });

    await (jobQueue as unknown as FakeJobQueue).__drainForTests();
    const record = await prisma.actionExecution.findFirstOrThrow({ where: { businessId: fresh.businessId, tool: "schedule_followup", status: { in: ["scheduled", "succeeded"] } } });
    expect(record.status).toBe("succeeded");
    const saved = await prisma.message.findFirst({ where: { conversationId: conversation.id, role: "assistant", content: "Checking in" } });
    expect(saved).not.toBeNull();
  });

  it("every tool invocation left an ActionExecution row attributed to the fresh business only", async () => {
    const rows = await prisma.actionExecution.findMany({ where: { businessId: fresh.businessId } });
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(new Set(rows.map((r) => r.status)).size).toBeGreaterThan(1); // honest mix of succeeded/failed/scheduled
    expect(await prisma.actionExecution.count({ where: { businessId: other.businessId } })).toBe(0);
  });
});
