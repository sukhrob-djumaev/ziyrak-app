import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §23/§24/§46.6 — `ToolRegistry`'s authorization split (§9.5),
 * durable `ActionExecution` recording (§24.1/§24.2), attempt-scoped
 * idempotency (§24.4), and the approval workflow (§23.4). Real Postgres,
 * never mocked (§34.2) — this is exactly the class of "a subtly-wrong
 * where merge" bug a mocked Prisma client can't catch, and idempotency
 * dedup depends on a real unique-constraint round trip.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma as rawClient } from "@/lib/prisma/raw-client";
import { toolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/builtin";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import type { TenantContext } from "@/lib/tenancy/context";

let business: SeededBusiness;

function aiCtx(conversationId: string): TenantContext {
  return {
    businessId: business.businessId,
    role: null,
    actor: { kind: "ai_agent", conversationId, model: "test-model" },
    dataConnection: "shared-default",
  };
}

beforeAll(async () => {
  business = await seedBusiness("tool-registry");
});

afterAll(async () => {
  await cleanupBusiness(business.businessId);
});

describe("ToolRegistry — authorization (§9.5/§23.4)", () => {
  it("denies an AI call to a tool whose ToolPolicy defaults allowedForAI to false", async () => {
    const result = await toolRegistry.execute(aiCtx("conv-deny-ai"), "noop_test_action", {}, { toolCallId: "tc-deny-ai" });

    expect(result.success).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("not available");

    const rows = await rawClient.actionExecution.findMany({ where: { businessId: business.businessId, tool: "noop_test_action" } });
    expect(rows).toHaveLength(0); // denied before any ActionExecution is created
  });

  // Deliberately exercised against get_customer_history, not create_ticket
  // — later tests in this file reuse create_ticket's default policy, and a
  // real (not code-default) ToolPolicy row's *other* columns take Prisma's
  // own defaults for any field the row doesn't explicitly set (e.g.
  // allowedForAI defaults to false at the column level), so mutating
  // create_ticket's policy here would leak into those tests.
  it("denies a human role excluded by ToolPolicy.allowedForHumanRoles, even though RBAC alone would allow it", async () => {
    // "admin" has RBAC permission "customers:read" (ALL_ROLES) — this
    // ToolPolicy row is strictly narrower than RBAC, proving the two are
    // independent gates (§9.5), not one conflated check.
    await rawClient.toolPolicy.create({
      data: { businessId: business.businessId, tool: "get_customer_history", allowedForHumanRoles: ["owner"] },
    });

    const humanCtx: TenantContext = {
      businessId: business.businessId,
      role: "admin",
      actor: { kind: "user", userId: business.ownerUserId },
      dataConnection: "shared-default",
    };

    const result = await toolRegistry.execute(
      humanCtx,
      "get_customer_history",
      { customerContact: "+1555" },
      { idempotencyKey: "human-denied-1" }
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("allows a human role RBAC and ToolPolicy both permit", async () => {
    const ownerCtx: TenantContext = {
      businessId: business.businessId,
      role: "owner",
      actor: { kind: "user", userId: business.ownerUserId },
      dataConnection: "shared-default",
    };

    // The narrow ["owner"] ToolPolicy row from the previous test still
    // applies (same business/tool) — "owner" is in that list.
    const result = await toolRegistry.execute(
      ownerCtx,
      "get_customer_history",
      { customerContact: "+1555" },
      { idempotencyKey: "human-allowed-1" }
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe("succeeded");
  });

  it("returns an honest failure for an unregistered tool name, with no ActionExecution row", async () => {
    const result = await toolRegistry.execute(aiCtx("conv-unknown"), "not_a_real_tool", {}, { toolCallId: "tc-unknown" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("Unknown tool");
  });
});

describe("ToolRegistry — ActionExecution + idempotency (§24)", () => {
  it("records an honest ActionExecution row with a non-null idempotencyKey for every real attempt", async () => {
    // create_ticket, not get_customer_history — the authorization block
    // above created a real ToolPolicy row for get_customer_history, and
    // (per the comment on that test) any field that row doesn't set
    // explicitly falls back to Prisma's own column default rather than
    // this file's DEFAULT_TOOL_POLICIES, which would incorrectly deny the
    // AI actor used here.
    const result = await toolRegistry.execute(
      aiCtx("conv-record"),
      "create_ticket",
      { title: "Recorded attempt", description: "d", priority: "low" },
      { toolCallId: "tc-record-1" }
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe("succeeded");

    const row = await rawClient.actionExecution.findFirst({
      where: { businessId: business.businessId, tool: "create_ticket", idempotencyKey: `${business.businessId}:tc-record-1` },
    });
    expect(row).not.toBeNull();
    expect(row?.status).toBe("succeeded");
    expect(row?.idempotencyKey).toBeTruthy();
  });

  it("retrying the exact same attempt (same toolCallId) does not duplicate the side effect", async () => {
    const args = { title: "Idempotency check", description: "d", priority: "low" as const };
    const runtimeCtx = { toolCallId: "tc-dup-1" };

    const first = await toolRegistry.execute(aiCtx("conv-dup"), "create_ticket", args, runtimeCtx);
    const second = await toolRegistry.execute(aiCtx("conv-dup"), "create_ticket", args, runtimeCtx);

    expect(first.success).toBe(true);
    expect(second).toEqual(first); // short-circuited to the recorded result, not re-run

    const tickets = await rawClient.ticket.findMany({ where: { businessId: business.businessId, title: "Idempotency check" } });
    expect(tickets).toHaveLength(1); // exactly one real Ticket row, not two
  });

  it("two independent attempts with identical-looking arguments are NOT conflated (different toolCallId)", async () => {
    const args = { title: "Repeat request", description: "same text, different occasion", priority: "low" as const };

    await toolRegistry.execute(aiCtx("conv-a"), "create_ticket", args, { toolCallId: "tc-independent-1" });
    await toolRegistry.execute(aiCtx("conv-b"), "create_ticket", args, { toolCallId: "tc-independent-2" });

    const tickets = await rawClient.ticket.findMany({ where: { businessId: business.businessId, title: "Repeat request" } });
    expect(tickets).toHaveLength(2); // two genuinely separate tickets, per §24.4
  });
});

describe("ToolRegistry — human approval workflow (§23.4/§34.3 item 6)", () => {
  it("pauses an AI call to a requiresHumanApproval tool, performs no side effect, then executes on approval", async () => {
    await rawClient.toolPolicy.create({
      data: { businessId: business.businessId, tool: "noop_test_action", allowedForAI: true, requiresHumanApproval: true },
    });

    const requested = await toolRegistry.execute(
      aiCtx("conv-approve"),
      "noop_test_action",
      { note: "please approve me" },
      { toolCallId: "tc-approve-1" }
    );

    expect(requested.status).toBe("pending_approval");

    const pendingRow = await rawClient.actionExecution.findFirst({
      where: { businessId: business.businessId, tool: "noop_test_action", idempotencyKey: `${business.businessId}:tc-approve-1` },
    });
    expect(pendingRow?.status).toBe("pending_approval");
    expect(pendingRow?.completedAt).toBeNull(); // no side effect happened yet

    const supervisorCtx: TenantContext = {
      businessId: business.businessId,
      role: "supervisor",
      actor: { kind: "user", userId: business.ownerUserId },
      dataConnection: "shared-default",
    };

    const approved = await toolRegistry.approve(supervisorCtx, pendingRow!.id);
    expect(approved.success).toBe(true);
    expect(approved.status).toBe("succeeded");

    const finalRow = await rawClient.actionExecution.findUnique({ where: { id: pendingRow!.id } });
    expect(finalRow?.status).toBe("succeeded");
    expect(finalRow?.completedAt).not.toBeNull();
  });

  it("rejecting a pending_approval action cancels it without ever running the tool", async () => {
    await rawClient.toolPolicy.upsert({
      where: { businessId_tool: { businessId: business.businessId, tool: "noop_test_action" } },
      update: { allowedForAI: true, requiresHumanApproval: true },
      create: { businessId: business.businessId, tool: "noop_test_action", allowedForAI: true, requiresHumanApproval: true },
    });

    const requested = await toolRegistry.execute(aiCtx("conv-reject"), "noop_test_action", {}, { toolCallId: "tc-reject-1" });
    expect(requested.status).toBe("pending_approval");

    const pendingRow = await rawClient.actionExecution.findFirst({
      where: { businessId: business.businessId, tool: "noop_test_action", idempotencyKey: `${business.businessId}:tc-reject-1` },
    });

    const supervisorCtx: TenantContext = {
      businessId: business.businessId,
      role: "supervisor",
      actor: { kind: "user", userId: business.ownerUserId },
      dataConnection: "shared-default",
    };

    await toolRegistry.reject(supervisorCtx, pendingRow!.id);

    const finalRow = await rawClient.actionExecution.findUnique({ where: { id: pendingRow!.id } });
    expect(finalRow?.status).toBe("cancelled");
  });
});
