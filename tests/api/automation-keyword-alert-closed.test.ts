import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/** L3.2 / F14 — the Keyword Alert rule type sends nothing, so it can no longer be created or chosen. Old rules can still be toggled and deleted. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { generateToken } from "@/lib/identity/auth";
import { createRequest } from "../helpers/request";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

let biz: SeededBusiness;
let token: string;
beforeAll(async () => {
  biz = await seedBusiness("kw-alert-closed");
  token = generateToken(biz.ownerUserId);
});
afterAll(async () => {
  await cleanupBusiness(biz.businessId);
});
const authed = (path: string, options: Parameters<typeof createRequest>[1] = {}) =>
  createRequest(path, { ...options, cookies: { "owly-token": token, ...options.cookies } });

const rule = (type: string) => ({
  name: "r",
  type,
  conditions: [{ field: "message_content", operator: "contains", value: "refund" }],
  actions: [{ type, value: "someone@example.test" }],
});

describe("keyword_alert rule type is closed", () => {
  it("refuses to create one, and still creates the supported types", async () => {
    const { POST } = await import("@/app/api/automation/route");
    expect((await POST(authed("/api/automation", { method: "POST", body: rule("keyword_alert") }))).status).toBe(400);
    expect((await POST(authed("/api/automation", { method: "POST", body: rule("auto_tag") }))).status).toBe(201);
  });

  it("refuses to change a rule into one but still lets an old one be switched off and deleted", async () => {
    const db = getScopedPrisma(biz.ctx);
    const tag = await db.automationRule.create({ data: { name: "t", type: "auto_tag", conditions: [], actions: [] } });
    const old = await db.automationRule.create({ data: { name: "old", type: "keyword_alert", conditions: [], actions: [] } });
    const { PUT, DELETE } = await import("@/app/api/automation/[id]/route");
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    expect((await PUT(authed(`/api/automation/${tag.id}`, { method: "PUT", body: { type: "keyword_alert" } }), ctx(tag.id))).status).toBe(400);
    expect((await PUT(authed(`/api/automation/${old.id}`, { method: "PUT", body: { isActive: false } }), ctx(old.id))).status).toBe(200);
    expect((await DELETE(authed(`/api/automation/${old.id}`, { method: "DELETE" }), ctx(old.id))).status).toBe(200);
  });
});
