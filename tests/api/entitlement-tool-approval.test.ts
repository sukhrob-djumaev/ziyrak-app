import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/** L4.1b - a tool needing a package capability disappears when the capability is lost, and an approval granted earlier cannot run it. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma/raw-client";
import { generateToken } from "@/lib/identity/auth";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { toolRegistry } from "@/lib/tools/registry";
import { DEFAULT_TOOL_POLICIES } from "@/lib/tools/policy";
import type { TenantContext } from "@/lib/tenancy/context";

const executed = vi.fn();
const TOOL = `needs_webhooks_${randomUUID().slice(0, 6)}`;
let biz: SeededBusiness;
let token: string;
let itemId: string;

async function holdWithout(capabilities: string[]) {
  await prisma.workspacePurchase.updateMany({ where: { businessId: biz.businessId, state: "active" }, data: { state: "ended", endsAt: new Date() } });
  const v = await prisma.catalogVersion.create({
    data: {
      itemId,
      version: (await prisma.catalogVersion.count({ where: { itemId } })) + 1,
      state: "published",
      name: "t",
      grants: ["channel.webchat", "automation.rules", "webhooks.outbound", "data.export"].filter((c) => !capabilities.includes(c)).map((capability) => ({ capability })),
      priceMinor: 0,
      currency: "USD",
      interval: "month",
      publishedAt: new Date(),
    },
  });
  await prisma.workspacePurchase.create({ data: { businessId: biz.businessId, versionId: v.id, source: "manual_test", reason: "t" } });
}

beforeAll(async () => {
  biz = await seedBusiness("tool-entitlement");
  token = generateToken(biz.ownerUserId);
  itemId = (await prisma.catalogItem.create({ data: { key: `tool-ent-${randomUUID().slice(0, 8)}`, kind: "bundle" } })).id;
  toolRegistry.register({
    name: TOOL,
    description: "test tool",
    schema: z.object({}),
    requiredCapability: "webhooks.outbound",
    async execute() {
      executed();
      return { success: true, status: "succeeded", message: "ran" };
    },
  } as never);
  DEFAULT_TOOL_POLICIES[TOOL] = { enabledForTenant: true, allowedForAI: true, allowedForHumanRoles: ["supervisor", "admin", "owner"], requiresHumanApproval: true };
}, 120_000);
afterAll(async () => {
  delete DEFAULT_TOOL_POLICIES[TOOL];
  await cleanupBusiness(biz.businessId);
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE "CatalogVersion" DISABLE TRIGGER "CatalogVersion_guard"');
    await prisma.workspacePurchase.deleteMany({ where: { version: { itemId } } });
    await prisma.catalogVersion.deleteMany({ where: { itemId } });
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "CatalogVersion" ENABLE TRIGGER "CatalogVersion_guard"');
  }
  await prisma.catalogItem.delete({ where: { id: itemId } });
});

const aiCtx = (): TenantContext => ({
  businessId: biz.businessId,
  role: null,
  actor: { kind: "ai_agent", conversationId: `conv-${randomUUID()}`, model: "m" },
  dataConnection: "shared-default",
  resourceScope: { kind: "workspace", customerProfileAccess: "write" },
});

describe("tool capability", () => {
  it("is offered while the package includes it and hidden once it does not", async () => {
    await holdWithout([]);
    expect((await toolRegistry.getAvailableTools(aiCtx())).map((t) => t.name)).toContain(TOOL);
    await holdWithout(["webhooks.outbound"]);
    expect((await toolRegistry.getAvailableTools(aiCtx())).map((t) => t.name)).not.toContain(TOOL);
  });

  it("an approval granted after the capability was lost never executes the tool", async () => {
    await holdWithout([]);
    const result = await toolRegistry.execute(aiCtx(), TOOL, {}, { toolCallId: `tc-${randomUUID()}` });
    expect(result.status).toBe("pending_approval");
    const row = await getScopedPrisma(biz.ctx).actionExecution.findFirst({ where: { tool: TOOL, status: "pending_approval" } });
    await holdWithout(["webhooks.outbound"]);
    const { POST } = await import("@/app/api/actions/[id]/approve/route");
    const res = await POST(createRequest(`/api/actions/${row!.id}/approve`, { method: "POST", cookies: { "owly-token": token } }), { params: Promise.resolve({ id: row!.id }) });
    const body = await parseJsonResponse(res);
    expect(body.status).toBe("failed");
    expect(executed).not.toHaveBeenCalled();
    const final = await getScopedPrisma(biz.ctx).actionExecution.findUnique({ where: { id: row!.id } });
    expect(final?.status).toBe("failed");
  });
});
