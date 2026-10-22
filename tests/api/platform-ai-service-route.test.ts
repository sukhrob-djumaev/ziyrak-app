import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/** PLAN.md P2 — the real platform gate: no anonymous or tenant-owner access to AI service management. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { generateToken } from "@/lib/identity/auth";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let owner: SeededBusiness;
let token: string;
beforeAll(async () => {
  owner = await seedBusiness("platform-ai-route");
  token = generateToken(owner.ownerUserId);
});
afterAll(async () => cleanupBusiness(owner.businessId));

describe("/api/platform/ai-service", () => {
  it("rejects anonymous callers", async () => {
    const { GET, POST } = await import("@/app/api/platform/ai-service/route");
    expect((await GET(createRequest("/api/platform/ai-service"))).status).toBe(401);
    expect((await POST(createRequest("/api/platform/ai-service", { method: "POST", body: {} }))).status).toBe(401);
  });

  it("refuses an ordinary workspace owner on read and on every write, changing nothing", async () => {
    const { GET, POST } = await import("@/app/api/platform/ai-service/route");
    const headers = { origin: "http://localhost:3000" };
    const cookies = { "owly-token": token };
    const read = await GET(createRequest("/api/platform/ai-service", { cookies }));
    expect([401, 403]).toContain(read.status);
    for (const body of [
      { action: "save_policy", kind: "generation", displayName: "x", provider: "openai", model: "m", apiKey: "sk-12345678", maxTokens: 10, temperature: 0.1, maxPromptTokens: 2000, maxToolDepth: 2, reason: "r" },
      { action: "set_allowance", businessId: owner.businessId, mode: "managed", status: "active", reason: "r" },
    ]) {
      const res = await POST(createRequest("/api/platform/ai-service", { method: "POST", body, cookies, headers }));
      expect([401, 403]).toContain(res.status);
      expect(JSON.stringify(await parseJsonResponse(res))).not.toContain("sk-12345678");
    }
    expect(await prisma.workspaceAiAllowance.count({ where: { businessId: owner.businessId } })).toBe(0);
  });
});
