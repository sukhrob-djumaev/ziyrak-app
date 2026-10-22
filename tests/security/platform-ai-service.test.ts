import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * PLAN.md P2 — super-admin-only management of managed AI policies and
 * per-workspace allowances. The platform authority gate itself
 * (withPlatformControl/readPlatformAuthority) is covered by
 * platform-authority.test.ts, which owns the platform singleton; here it is
 * replaced by a role switch so this file can run in parallel with it.
 */
const gate = vi.hoisted(() => ({ role: "super_admin" as "super_admin" | "operator" | null, userId: "" }));
vi.mock("@/lib/platform/access/authority", async () => {
  const { prisma } = await import("@/lib/prisma/raw-client");
  const { AppError } = await import("@/lib/observability/errors");
  const authority = () => {
    if (!gate.role) throw new AppError(401, "UNAUTHORIZED", "A current revocable person session is required");
    return { userId: gate.userId, role: gate.role, generation: 1, sessionJti: "j", sessionExpiresAt: 0 };
  };
  return {
    readPlatformAuthority: async () => authority(),
    withPlatformControl: async (_t: string, required: string, fn: (tx: unknown, actor: unknown) => Promise<unknown>) => {
      const actor = authority();
      if (required === "super_admin" && actor.role !== "super_admin")
        throw new AppError(403, "FORBIDDEN", "Super admin authority is required");
      return prisma.$transaction((tx) => fn(tx, actor));
    },
  };
});
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { readAiServiceConsole, savePolicy, setWorkspaceAllowance } from "@/lib/platform/ai-service";
import { resolveAIConfig } from "@/lib/ai/config";
import { acquirePolicyLock, releasePolicyLock, acquirePlatformLock, releasePlatformLock } from "../helpers/policy-lock";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let ws: SeededBusiness;
let adminId: string;
const policyInput = {
  kind: "generation",
  displayName: "Standard assistant",
  provider: "openai",
  model: "gpt-4o-mini",
  apiKey: "sk-platform-secret-123",
  maxTokens: 800,
  temperature: 0.3,
  maxPromptTokens: 12000,
  maxToolDepth: 4,
  reason: "initial policy",
};

beforeAll(async () => {
  await acquirePolicyLock();
  await acquirePlatformLock();
  ws = await seedBusiness("platform-ai-service");
  const admin = await prisma.user.create({
    data: { username: `ai-admin-${Date.now()}`, password: "x", name: "Admin", platformRole: "super_admin" },
  });
  adminId = admin.id;
}, 120_000);
afterAll(async () => {
  await prisma.aiServicePolicy.deleteMany({});
  await prisma.platformAccessAudit.deleteMany({ where: { actorUserId: adminId } });
  await cleanupBusiness(ws.businessId);
  await prisma.user.delete({ where: { id: adminId } });
  await releasePlatformLock();
  await releasePolicyLock();
});
beforeEach(async () => {
  gate.role = "super_admin";
  gate.userId = adminId;
  await prisma.platformAccessAudit.deleteMany({ where: { actorUserId: adminId } });
  await prisma.aiServicePolicy.deleteMany({});
  await prisma.workspaceAiAllowance.deleteMany({ where: { businessId: ws.businessId } });
});

describe("authority", () => {
  it("refuses operators and unauthenticated callers on every operation", async () => {
    for (const role of ["operator", null] as const) {
      gate.role = role;
      await expect(readAiServiceConsole("t")).rejects.toMatchObject({ statusCode: expect.any(Number) });
      await expect(savePolicy("t", policyInput)).rejects.toMatchObject({ statusCode: expect.any(Number) });
      await expect(
        setWorkspaceAllowance("t", { businessId: ws.businessId, mode: "managed", status: "active", reason: "x" })
      ).rejects.toMatchObject({ statusCode: expect.any(Number) });
    }
    expect(await prisma.aiServicePolicy.count()).toBe(0);
    expect(await prisma.workspaceAiAllowance.count({ where: { businessId: ws.businessId } })).toBe(0);
  });
});

describe("savePolicy", () => {
  it("stores the key encrypted, activates the new version, and never returns the key", async () => {
    const saved = await savePolicy("t", policyInput);
    const row = await prisma.aiServicePolicy.findFirstOrThrow({});
    expect(row.credentialRef).toBeTruthy();
    expect(row.credentialRef).not.toContain("sk-platform-secret-123");
    expect(JSON.stringify(saved)).not.toContain("sk-platform-secret-123");
    expect(JSON.stringify(saved)).not.toContain(row.credentialRef!);
    expect(row).toMatchObject({ version: 1, active: true, maxToolDepth: 4 });
    const audit = await prisma.platformAccessAudit.findFirst({ where: { actorUserId: adminId, action: "ai.policy.save" } });
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).not.toContain("sk-platform-secret-123");
  });

  it("a new version deactivates the old one; omitting the key keeps the previous credential for the same provider", async () => {
    await savePolicy("t", policyInput);
    const { apiKey: _omit, ...withoutKey } = policyInput;
    void _omit;
    await savePolicy("t", { ...withoutKey, model: "gpt-4o", reason: "model change" });
    const rows = await prisma.aiServicePolicy.findMany({ orderBy: { version: "asc" } });
    expect(rows.map((r) => [r.version, r.active])).toEqual([[1, false], [2, true]]);
    expect(rows[1].credentialRef).toBe(rows[0].credentialRef);
  });

  it("rejects a first policy with no key, an unknown provider, and out-of-range bounds", async () => {
    const { apiKey: _omit, ...withoutKey } = policyInput;
    void _omit;
    await expect(savePolicy("t", withoutKey)).rejects.toMatchObject({ statusCode: 400 });
    await expect(savePolicy("t", { ...policyInput, provider: "ollama" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(savePolicy("t", { ...policyInput, kind: "embedding", provider: "anthropic" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(savePolicy("t", { ...policyInput, maxToolDepth: 50 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(savePolicy("t", { ...policyInput, unexpected: true })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("the saved policy is what a managed workspace resolves", async () => {
    await savePolicy("t", policyInput);
    await setWorkspaceAllowance("t", { businessId: ws.businessId, mode: "managed", status: "active", reason: "onboard" });
    expect(await resolveAIConfig(ws.ctx)).toMatchObject({ managed: true, model: "gpt-4o-mini", apiKey: "sk-platform-secret-123", maxToolDepth: 4 });
  });
});

describe("setWorkspaceAllowance and the console", () => {
  it("creates an allowance with the approved defaults, updates limits, and audits each change", async () => {
    await setWorkspaceAllowance("t", { businessId: ws.businessId, mode: "managed", status: "active", reason: "onboard" });
    expect(await prisma.workspaceAiAllowance.findUniqueOrThrow({ where: { businessId: ws.businessId } })).toMatchObject({
      generationLimitTokens: 500_000,
      embeddingLimitTokens: 1_000_000,
    });
    await setWorkspaceAllowance("t", { businessId: ws.businessId, mode: "managed", status: "suspended", generationLimitTokens: 10, reason: "abuse" });
    expect(await prisma.workspaceAiAllowance.findUniqueOrThrow({ where: { businessId: ws.businessId } })).toMatchObject({
      status: "suspended",
      generationLimitTokens: 10,
      embeddingLimitTokens: 1_000_000,
    });
    expect(await prisma.platformAccessAudit.count({ where: { actorUserId: adminId, action: "ai.allowance.set", businessId: ws.businessId } })).toBe(2);
  });

  it("rejects an unknown workspace, negative limits and unknown fields", async () => {
    await expect(setWorkspaceAllowance("t", { businessId: "nope", mode: "managed", status: "active", reason: "x" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(setWorkspaceAllowance("t", { businessId: ws.businessId, mode: "managed", status: "active", generationLimitTokens: -1, reason: "x" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(setWorkspaceAllowance("t", { businessId: ws.businessId, mode: "managed", status: "active", reason: "x", extra: 1 })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("the console counts every charged row, not only settled ones", async () => {
    const base = { businessId: ws.businessId, kind: "generation", periodStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)), expiresAt: new Date() };
    await prisma.aiUsageReservation.deleteMany({ where: { businessId: ws.businessId } });
    await prisma.aiUsageReservation.createMany({
      data: [
        { ...base, reservedTokens: 100, settledTokens: 40, state: "settled", idempotencyKey: "c1" },
        { ...base, reservedTokens: 300, state: "uncertain", idempotencyKey: "c2" },
        { ...base, reservedTokens: 50, state: "reserved", idempotencyKey: "c3" },
        { ...base, reservedTokens: 999, state: "released", idempotencyKey: "c4" },
      ],
    });
    await setWorkspaceAllowance("t", { businessId: ws.businessId, mode: "managed", status: "active", reason: "x" });
    const row = (await readAiServiceConsole("t")).workspaces.find((w) => w.businessId === ws.businessId);
    expect(row?.generationUsed).toBe(40 + 300 + 50);
    await prisma.aiUsageReservation.deleteMany({ where: { businessId: ws.businessId } });
  });

  it("the console lists policies and workspaces without any credential", async () => {
    await savePolicy("t", policyInput);
    await setWorkspaceAllowance("t", { businessId: ws.businessId, mode: "managed", status: "active", reason: "onboard" });
    const consoleView = await readAiServiceConsole("t");
    const text = JSON.stringify(consoleView);
    expect(text).not.toContain("sk-platform-secret-123");
    expect(text).not.toContain("credentialRef");
    expect(consoleView.policies[0]).toMatchObject({ kind: "generation", version: 1, active: true, hasCredential: true });
    expect(consoleView.workspaces.find((w) => w.businessId === ws.businessId)).toMatchObject({ mode: "managed", status: "active" });
  });
});
