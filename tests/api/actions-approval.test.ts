import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §23.4/§9.5/§46.6 — the human-reachable side of the approval-
 * gated execution path: `POST /api/actions/[id]/approve` and `/reject`.
 * Real Postgres + real auth, same pattern as
 * `tests/security/auth-bypass-regression.test.ts`.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { generateToken } from "@/lib/identity/auth";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { seedBusiness, cleanupBusiness, addMember, type SeededBusiness } from "../helpers/tenant-fixtures";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { toolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/builtin";
import type { TenantContext } from "@/lib/tenancy/context";

let businessA: SeededBusiness;
let businessB: SeededBusiness;
let ownerTokenA: string;
let viewerTokenA: string;

beforeAll(async () => {
  businessA = await seedBusiness("actions-approval-a");
  businessB = await seedBusiness("actions-approval-b");
  ownerTokenA = generateToken(businessA.ownerUserId);
  const viewer = await addMember(businessA.businessId, "viewer", "actions-viewer");
  viewerTokenA = generateToken(viewer.userId);
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

function authedRequest(path: string, token: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": token, ...options.cookies } });
}

async function seedPendingApproval(business: SeededBusiness) {
  await getScopedPrisma(business.ctx).toolPolicy.upsert({
    where: { businessId_tool: { businessId: business.businessId, tool: "noop_test_action" } },
    update: { allowedForAI: true, requiresHumanApproval: true },
    create: { businessId: business.businessId, tool: "noop_test_action", allowedForAI: true, requiresHumanApproval: true },
  });

  const aiCtx: TenantContext = {
    businessId: business.businessId,
    role: null,
    actor: { kind: "ai_agent", conversationId: `conv-${business.businessId}`, model: "test-model" },
    dataConnection: "shared-default",
  };
  const result = await toolRegistry.execute(aiCtx, "noop_test_action", {}, { toolCallId: `tc-${Date.now()}-${Math.random()}` });
  expect(result.status).toBe("pending_approval");

  const row = await getScopedPrisma(business.ctx).actionExecution.findFirst({
    where: { businessId: business.businessId, tool: "noop_test_action", status: "pending_approval" },
    orderBy: { createdAt: "desc" },
  });
  return row!;
}

describe("POST /api/actions/[id]/approve and /reject (§23.4/§46.6)", () => {
  it("a supervisor approving a pending action actually runs it, transitioning to succeeded", async () => {
    const pending = await seedPendingApproval(businessA);

    const { POST } = await import("@/app/api/actions/[id]/approve/route");
    const response = await POST(authedRequest(`/api/actions/${pending.id}/approve`, ownerTokenA, { method: "POST" }), {
      params: Promise.resolve({ id: pending.id }),
    });
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.status).toBe("succeeded");

    const finalRow = await getScopedPrisma(businessA.ctx).actionExecution.findUnique({ where: { id: pending.id } });
    expect(finalRow?.status).toBe("succeeded");
  });

  it("rejecting a pending action cancels it without ever running the tool", async () => {
    const pending = await seedPendingApproval(businessA);

    const { POST } = await import("@/app/api/actions/[id]/reject/route");
    const response = await POST(authedRequest(`/api/actions/${pending.id}/reject`, ownerTokenA, { method: "POST" }), {
      params: Promise.resolve({ id: pending.id }),
    });

    expect(response.status).toBe(200);
    const finalRow = await getScopedPrisma(businessA.ctx).actionExecution.findUnique({ where: { id: pending.id } });
    expect(finalRow?.status).toBe("cancelled");
  });

  it("a viewer (below actions:approve's required role) is rejected by RBAC", async () => {
    const pending = await seedPendingApproval(businessA);

    const { POST } = await import("@/app/api/actions/[id]/approve/route");
    const response = await POST(authedRequest(`/api/actions/${pending.id}/approve`, viewerTokenA, { method: "POST" }), {
      params: Promise.resolve({ id: pending.id }),
    });

    expect(response.status).toBe(403);
    const row = await getScopedPrisma(businessA.ctx).actionExecution.findUnique({ where: { id: pending.id } });
    expect(row?.status).toBe("pending_approval"); // untouched
  });

  it("Business A cannot approve Business B's pending action via a known id", async () => {
    const pendingB = await seedPendingApproval(businessB);

    const { POST } = await import("@/app/api/actions/[id]/approve/route");
    const response = await POST(authedRequest(`/api/actions/${pendingB.id}/approve`, ownerTokenA, { method: "POST" }), {
      params: Promise.resolve({ id: pendingB.id }),
    });

    expect(response.status).toBe(404); // §33.3 — indistinguishable from "does not exist"
    const row = await getScopedPrisma(businessB.ctx).actionExecution.findUnique({ where: { id: pendingB.id } });
    expect(row?.status).toBe("pending_approval"); // untouched by Business A's attempt
  });
});
