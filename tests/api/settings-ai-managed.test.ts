import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * PLAN.md P2 — a managed workspace sees only safe service/usage state and
 * cannot read or change provider, model, key or limits through the API.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { generateToken } from "@/lib/identity/auth";
import { encryptAIProviderCredential } from "@/lib/ai/config";
import { periodStartFor } from "@/lib/ai/allowance";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { acquirePolicyLock, releasePolicyLock } from "../helpers/policy-lock";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let a: SeededBusiness;
let token: string;

beforeAll(async () => {
  await acquirePolicyLock();
  a = await seedBusiness("settings-ai-managed");
  token = generateToken(a.ownerUserId);
});
afterAll(async () => {
  await prisma.aiServicePolicy.deleteMany({});
  await cleanupBusiness(a.businessId);
  await releasePolicyLock();
});
beforeEach(async () => {
  await prisma.aiServicePolicy.deleteMany({});
  await prisma.aiServicePolicy.create({
    data: {
      kind: "generation",
      version: 1,
      active: true,
      displayName: "Standard assistant",
      provider: "openai",
      model: "secret-model-id",
      credentialRef: await encryptAIProviderCredential("openai", "sk-platform-secret"),
    },
  });
  await prisma.aiUsageReservation.deleteMany({ where: { businessId: a.businessId } });
  await prisma.workspaceAiAllowance.upsert({
    where: { businessId: a.businessId },
    create: { businessId: a.businessId, mode: "managed", generationLimitTokens: 1000, embeddingLimitTokens: 2000 },
    update: { mode: "managed", status: "active", generationLimitTokens: 1000, embeddingLimitTokens: 2000 },
  });
});

const req = (method: string, body?: unknown) =>
  createRequest("/api/settings/ai", { method, body, cookies: { "owly-token": token } });

async function usedTokens(n: number) {
  await prisma.aiUsageReservation.create({
    data: {
      businessId: a.businessId,
      kind: "generation",
      periodStart: periodStartFor(new Date()),
      reservedTokens: n,
      settledTokens: n,
      state: "settled",
      idempotencyKey: `seed-${n}-${Math.random()}`,
      expiresAt: new Date(),
    },
  });
}

describe("managed workspace AI settings", () => {
  it("returns service name, usage, limit and reset date with no provider, model or key", async () => {
    await usedTokens(300);
    const { GET } = await import("@/app/api/settings/ai/route");
    const res = await GET(req("GET"));
    const data = await parseJsonResponse(res);
    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      managed: true,
      serviceName: "Standard assistant",
      status: "ok",
      generation: { used: 300, limit: 1000 },
      embedding: { used: 0, limit: 2000 },
    });
    expect(data.resetsAt).toBeTruthy();
    const text = JSON.stringify(data);
    for (const leak of ["secret-model-id", "sk-platform-secret", "openai", "credentialRef", "aiCredentialRef"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("reports near_limit at 80 percent, exhausted at the limit, suspended and not_configured", async () => {
    const { GET } = await import("@/app/api/settings/ai/route");
    await usedTokens(850);
    expect((await parseJsonResponse(await GET(req("GET")))).status).toBe("near_limit");
    await usedTokens(150);
    expect((await parseJsonResponse(await GET(req("GET")))).status).toBe("exhausted");
    await prisma.workspaceAiAllowance.update({ where: { businessId: a.businessId }, data: { status: "suspended" } });
    expect((await parseJsonResponse(await GET(req("GET")))).status).toBe("suspended");
    await prisma.workspaceAiAllowance.update({ where: { businessId: a.businessId }, data: { status: "active" } });
    await prisma.aiServicePolicy.deleteMany({});
    expect((await parseJsonResponse(await GET(req("GET")))).status).toBe("not_configured");
  });

  it("refuses every write, including model, provider, key and limits", async () => {
    const { PUT } = await import("@/app/api/settings/ai/route");
    for (const body of [
      { aiProvider: "anthropic" },
      { aiModel: "gpt-x" },
      { aiApiKey: "sk-own-key" },
      { embeddingApiKey: "sk-own-key" },
      { maxTokens: 4000 },
    ]) {
      const res = await PUT(req("PUT", body));
      expect(res.status).toBe(403);
      expect((await parseJsonResponse(res)).error.code).toBe("AI_MANAGED");
    }
    const config = await prisma.businessConfig.findUnique({ where: { businessId: a.businessId } });
    expect(config?.aiCredentialRef ?? null).toBeNull();
  });

  it("leaves a non-managed workspace's view and writes unchanged", async () => {
    await prisma.workspaceAiAllowance.update({ where: { businessId: a.businessId }, data: { mode: "legacy_byok" } });
    const { GET, PUT } = await import("@/app/api/settings/ai/route");
    expect((await parseJsonResponse(await GET(req("GET")))).managed).toBeUndefined();
    expect((await PUT(req("PUT", { aiProvider: "openai", aiModel: "gpt-4o-mini" }))).status).toBe(200);
  });
});
