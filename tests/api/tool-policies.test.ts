import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * Tool policy management: the dashboard needs a way for a business to decide
 * which AI tools are on, which roles may run them, and which need a human to
 * approve first — before this, only a database row could do that, so the
 * approvals queue could never fill. Real Postgres + real auth; the end-to-end
 * case proves a policy change actually gates the AI (not just a row).
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { generateToken } from "@/lib/identity/auth";
import { createRequest, parseJsonResponse } from "../helpers/request";
import {
  seedBusiness,
  cleanupBusiness,
  addMember,
  type SeededBusiness,
} from "../helpers/tenant-fixtures";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { toolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/builtin";
import type { TenantContext } from "@/lib/tenancy/context";

let a: SeededBusiness;
let b: SeededBusiness;
let ownerToken: string;
let supervisorToken: string;
let agentToken: string;

beforeAll(async () => {
  a = await seedBusiness("tool-policy-a");
  b = await seedBusiness("tool-policy-b");
  ownerToken = generateToken(a.ownerUserId);
  supervisorToken = generateToken(
    (await addMember(a.businessId, "supervisor", "tp-supervisor")).userId
  );
  agentToken = generateToken((await addMember(a.businessId, "agent", "tp-agent")).userId);
});

afterAll(async () => {
  await cleanupBusiness(a.businessId);
  await cleanupBusiness(b.businessId);
});

const authed = (path: string, token: string, options: Parameters<typeof createRequest>[1] = {}) =>
  createRequest(path, { ...options, cookies: { "owly-token": token } });

async function list(token: string) {
  const { GET } = await import("@/app/api/tool-policies/route");
  return GET(authed("/api/tool-policies", token));
}
async function put(token: string, tool: string, body: Record<string, unknown>) {
  const { PUT } = await import("@/app/api/tool-policies/[tool]/route");
  return PUT(authed(`/api/tool-policies/${tool}`, token, { method: "PUT", body }), {
    params: Promise.resolve({ tool }),
  });
}
async function reset(token: string, tool: string) {
  const { DELETE } = await import("@/app/api/tool-policies/[tool]/route");
  return DELETE(authed(`/api/tool-policies/${tool}`, token, { method: "DELETE" }), {
    params: Promise.resolve({ tool }),
  });
}

describe("GET /api/tool-policies", () => {
  it("lists every business-visible tool with its effective policy and whether it is customised", async () => {
    const response = await list(ownerToken);
    expect(response.status).toBe(200);
    const { data } = await parseJsonResponse(response);
    const names = data.map((t: { tool: string }) => t.tool);
    expect(names).toEqual(
      expect.arrayContaining([
        "create_ticket",
        "send_internal_email",
        "trigger_webhook",
        "schedule_followup",
      ])
    );
    expect(names).not.toContain("noop_test_action"); // internal test tool is not a business setting
    const ticket = data.find((t: { tool: string }) => t.tool === "create_ticket");
    expect(ticket).toMatchObject({
      customized: false,
      description: expect.any(String),
      policy: { enabledForTenant: true, allowedForAI: true, requiresHumanApproval: false },
    });
  });

  it("is allowed for supervisors (read-only) and refused for agents", async () => {
    const supervisor = await list(supervisorToken);
    expect(supervisor.status).toBe(200);
    expect((await parseJsonResponse(supervisor)).canEdit).toBe(false);
    expect((await parseJsonResponse(await list(ownerToken))).canEdit).toBe(true);
    expect((await list(agentToken)).status).toBe(403);
  });
});

describe("customised means different from the default, not merely having a row", () => {
  it("a signup-seeded row equal to the default is not customised; a real change is; changing it back is not", async () => {
    // Signup seeds one row per tool, equal to the default (platform/provisioning.ts).
    // (Under SEED_VIA_SIGNUP=1 the business already has this row, so upsert rather than create.)
    const equalToDefault = {
      enabledForTenant: true,
      allowedForAI: true,
      allowedForHumanRoles: ["agent", "supervisor", "admin", "owner"],
      requiresHumanApproval: false,
    };
    await getScopedPrisma(a.ctx).toolPolicy.upsert({
      where: { businessId_tool: { businessId: a.businessId, tool: "get_customer_history" } },
      update: equalToDefault,
      create: { businessId: a.businessId, tool: "get_customer_history", ...equalToDefault },
    });
    const find = async () =>
      (await parseJsonResponse(await list(ownerToken))).data.find(
        (t: { tool: string }) => t.tool === "get_customer_history"
      );
    expect((await find()).customized).toBe(false);

    await put(ownerToken, "get_customer_history", { allowedForAI: false });
    expect((await find()).customized).toBe(true);

    await put(ownerToken, "get_customer_history", {
      allowedForAI: true,
      allowedForHumanRoles: ["owner", "admin", "supervisor", "agent"],
    }); // same roles, different order
    expect((await find()).customized).toBe(false);
  });
});

describe("PUT /api/tool-policies/[tool]", () => {
  it("lets an owner require approval, keeping every other field at its effective value", async () => {
    const response = await put(ownerToken, "send_internal_email", { requiresHumanApproval: true });
    expect(response.status).toBe(200);
    const body = await parseJsonResponse(response);
    expect(body).toMatchObject({
      tool: "send_internal_email",
      customized: true,
      policy: { requiresHumanApproval: true, allowedForAI: true, enabledForTenant: true },
    });
    expect(body.policy.allowedForHumanRoles).toEqual(["agent", "supervisor", "admin", "owner"]);
  });

  it("is business-scoped: another business keeps the default", async () => {
    const { data } = await parseJsonResponse(await list(generateToken(b.ownerUserId)));
    const mine = data.find((t: { tool: string }) => t.tool === "send_internal_email");
    expect(mine.customized).toBe(false);
    expect(mine.policy.requiresHumanApproval).toBe(false);
  });

  it("refuses supervisors and agents (admin and owner only)", async () => {
    expect((await put(supervisorToken, "create_ticket", { enabledForTenant: false })).status).toBe(
      403
    );
    expect((await put(agentToken, "create_ticket", { enabledForTenant: false })).status).toBe(403);
    const { data } = await parseJsonResponse(await list(ownerToken));
    expect(data.find((t: { tool: string }) => t.tool === "create_ticket").customized).toBe(false);
  });

  it("rejects unknown tools, the internal test tool, unknown roles and non-boolean flags", async () => {
    expect((await put(ownerToken, "does_not_exist", { enabledForTenant: false })).status).toBe(404);
    expect((await put(ownerToken, "noop_test_action", { enabledForTenant: false })).status).toBe(
      404
    );
    expect(
      (await put(ownerToken, "create_ticket", { allowedForHumanRoles: ["agent", "superuser"] }))
        .status
    ).toBe(400);
    // Viewers are read-only by definition: a policy must not be able to let them run tools.
    expect(
      (await put(ownerToken, "create_ticket", { allowedForHumanRoles: ["viewer", "agent"] })).status
    ).toBe(400);
    expect((await put(ownerToken, "create_ticket", { requiresHumanApproval: "yes" })).status).toBe(
      400
    );
    expect((await put(ownerToken, "create_ticket", {})).status).toBe(400); // nothing to change
  });

  it("records who changed what in the activity log", async () => {
    await put(ownerToken, "trigger_webhook", { allowedForAI: false });
    const entry = await getScopedPrisma(a.ctx).activityLog.findFirst({
      where: { action: "tool_policy.updated", entityId: "trigger_webhook" },
      orderBy: { createdAt: "desc" },
    });
    expect(entry).not.toBeNull();
    expect(entry!.description).toMatch(/trigger_webhook/);
    expect(entry!.userId).toBe(a.ownerUserId);
  });
});

describe("concurrent edits and the audit trail (security review)", () => {
  it("two simultaneous edits of different fields are both kept (no lost update)", async () => {
    await reset(ownerToken, "get_customer_history");
    await Promise.all([
      put(ownerToken, "get_customer_history", { allowedForAI: false }),
      put(ownerToken, "get_customer_history", { requiresHumanApproval: true }),
      put(ownerToken, "get_customer_history", { allowedForHumanRoles: ["owner", "admin"] }),
    ]);
    const { data } = await parseJsonResponse(await list(ownerToken));
    const policy = data.find((t: { tool: string }) => t.tool === "get_customer_history").policy;
    expect(policy).toMatchObject({ allowedForAI: false, requiresHumanApproval: true });
    expect([...policy.allowedForHumanRoles].sort()).toEqual(["admin", "owner"]);
  });

  it("records the previous values and flags changes that widen what the AI may do", async () => {
    await reset(ownerToken, "trigger_webhook");
    await put(ownerToken, "trigger_webhook", { requiresHumanApproval: true }); // narrowing
    await put(ownerToken, "trigger_webhook", { requiresHumanApproval: false, allowedForAI: true }); // widening: approval removed
    const entries = await getScopedPrisma(a.ctx).activityLog.findMany({
      where: { action: "tool_policy.updated", entityId: "trigger_webhook" },
      orderBy: { createdAt: "asc" },
    });
    const meta = entries.map(
      (e) =>
        e.metadata as {
          changes: Record<string, unknown>;
          before: Record<string, unknown>;
          widensAccess: boolean;
        }
    );
    const narrowing = meta[meta.length - 2];
    const widening = meta[meta.length - 1];
    expect(narrowing).toMatchObject({
      before: { requiresHumanApproval: false },
      changes: { requiresHumanApproval: true },
      widensAccess: false,
    });
    expect(widening).toMatchObject({
      before: { requiresHumanApproval: true },
      changes: { requiresHumanApproval: false },
      widensAccess: true,
    });
  });
});

describe("a saved policy actually gates the AI", () => {
  const aiCtx = (): TenantContext => ({
    businessId: a.businessId,
    role: null,
    actor: { kind: "ai_agent", conversationId: `conv-${a.businessId}`, model: "test-model" },
    dataConnection: "shared-default",
    resourceScope: { kind: "workspace" as const, customerProfileAccess: "write" as const },
  });

  it("send_internal_email now waits for approval when the policy says so", async () => {
    await put(ownerToken, "send_internal_email", { requiresHumanApproval: true });
    const result = await toolRegistry.execute(
      aiCtx(),
      "send_internal_email",
      { to: "team@example.com", subject: "s", body: "b" },
      { toolCallId: `tc-${Math.random()}` }
    );
    expect(result.status).toBe("pending_approval");
  });

  it("a disabled tool is not available to the AI at all", async () => {
    await put(ownerToken, "assign_to_person", { enabledForTenant: false });
    const result = await toolRegistry.execute(
      aiCtx(),
      "assign_to_person",
      { ticketId: "t-1" },
      { toolCallId: `tc-${Math.random()}` }
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not available/);
  });
});

describe("DELETE /api/tool-policies/[tool]", () => {
  it("resets a customised tool to its default and is harmless when already default", async () => {
    await put(ownerToken, "schedule_followup", { allowedForAI: false });
    const response = await reset(ownerToken, "schedule_followup");
    expect(response.status).toBe(200);
    expect(await parseJsonResponse(response)).toMatchObject({
      tool: "schedule_followup",
      customized: false,
      policy: { allowedForAI: true },
    });
    expect((await reset(ownerToken, "schedule_followup")).status).toBe(200);
    expect((await reset(supervisorToken, "schedule_followup")).status).toBe(403);
  });
});
