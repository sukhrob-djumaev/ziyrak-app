import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

/** L4.1c - platform-wide AI ceilings (concurrent workspaces), the daily signup cap and the audited console write. */
const gate = vi.hoisted(() => ({ role: "super_admin" as "super_admin" | "operator", userId: "" }));
vi.mock("@/lib/platform/access/authority", async () => {
  const { prisma } = await import("@/lib/prisma/raw-client");
  const { AppError } = await import("@/lib/observability/errors");
  return {
    withPlatformControl: async (_t: string, required: string, fn: (tx: unknown, actor: unknown) => Promise<unknown>) => {
      const actor = { userId: gate.userId, role: gate.role, generation: 1, sessionJti: "j", sessionExpiresAt: 0 };
      if (required === "super_admin" && actor.role !== "super_admin") throw new AppError(403, "FORBIDDEN", "Super admin authority is required");
      return prisma.$transaction((tx) => fn(tx, actor));
    },
  };
});
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { reserveAllowance, settleReservation, releaseReservation } from "@/lib/ai/allowance";
import { setPlatformLimit } from "@/lib/platform/limits-console";
import { PLATFORM_LIMITS, readLimit } from "@/lib/platform/limits";
import { assertSignupCapacity } from "@/lib/platform/provisioning";
import { acquirePlatformLock, releasePlatformLock } from "../helpers/policy-lock";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

// A month no other test reserves in, so the platform-wide sum below holds only this file's rows.
const NOW = new Date("2031-03-15T12:00:00Z");
// Token amounts are scaled by U so the lowered ceiling (always >= 5M) stays far above anything other files reserve at the real "now".
const U = 5000;
const PERIOD = new Date("2031-03-01T00:00:00Z");
let a: SeededBusiness;
let b: SeededBusiness;
let adminId: string;

async function allowance(businessId: string, tokens: number) {
  await prisma.workspaceAiAllowance.upsert({
    where: { businessId },
    create: { businessId, generationLimitTokens: tokens, embeddingLimitTokens: tokens },
    update: { generationLimitTokens: tokens, embeddingLimitTokens: tokens },
  });
}
const reserve = (businessId: string, tokens: number, key: string, kind: "generation" | "embedding" = "generation") =>
  reserveAllowance({ businessId, kind, tokens, idempotencyKey: key, now: NOW });

beforeAll(async () => {
  await acquirePlatformLock();
  a = await seedBusiness("limits-a");
  b = await seedBusiness("limits-b");
  adminId = (await prisma.user.create({ data: { username: `lim-admin-${Date.now()}`, password: "x", name: "A", platformRole: "super_admin" } })).id;
  await allowance(a.businessId, 1_000_000_000);
  await allowance(b.businessId, 1_000_000_000);
}, 120_000);
afterAll(async () => {
  await prisma.platformLimit.deleteMany({});
  await prisma.aiUsageReservation.deleteMany({ where: { periodStart: PERIOD } });
  await prisma.platformAccessAudit.deleteMany({ where: { actorUserId: adminId } });
  await cleanupBusiness(a.businessId);
  await cleanupBusiness(b.businessId);
  await prisma.user.delete({ where: { id: adminId } });
  await releasePlatformLock();
});
// The limit row is global: clear it right after each test so files running in parallel see the defaults again.
afterEach(async () => {
  await prisma.platformLimit.deleteMany({});
});
beforeEach(async () => {
  gate.role = "super_admin";
  gate.userId = adminId;
  await prisma.platformLimit.deleteMany({});
  await prisma.aiUsageReservation.deleteMany({ where: { periodStart: PERIOD } });
});

describe("platform AI ceiling", () => {
  it("uses the code default when no row exists", async () => {
    expect(await readLimit(prisma, "monthly_generation_tokens_ceiling")).toBe(PLATFORM_LIMITS.monthly_generation_tokens_ceiling.def);
  });

  it("refuses a reservation that would pass the ceiling even though the workspace has room", async () => {
    await setPlatformLimit("t", { key: "monthly_generation_tokens_ceiling", value: 1000 * U, reason: "test" });
    expect(await reserve(a.businessId, 700 * U, "a1")).toMatchObject({ ok: true });
    expect(await reserve(b.businessId, 400 * U, "b1")).toEqual({ ok: false, reason: "platform_ceiling" });
    expect(await reserve(b.businessId, 300 * U, "b2")).toMatchObject({ ok: true });
    expect(await reserve(b.businessId, 1 * U, "b3")).toEqual({ ok: false, reason: "platform_ceiling" });
  });

  it("holds the ceiling under concurrent reservations from two workspaces", async () => {
    await setPlatformLimit("t", { key: "monthly_generation_tokens_ceiling", value: 1000 * U, reason: "test" });
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => reserve(i % 2 ? a.businessId : b.businessId, 100 * U, `c${i}`)));
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "platform_ceiling")).toBe(true);
    const sum = await prisma.aiUsageReservation.aggregate({ _sum: { reservedTokens: true }, where: { periodStart: PERIOD } });
    expect(sum._sum.reservedTokens).toBe(1000 * U);
  });

  it("frees room when a reservation is released and counts settled actuals, not the bound", async () => {
    await setPlatformLimit("t", { key: "monthly_generation_tokens_ceiling", value: 1000 * U, reason: "test" });
    const first = await reserve(a.businessId, 900 * U, "r1");
    if (!first.ok) throw new Error("setup");
    expect(await reserve(b.businessId, 200 * U, "r2")).toEqual({ ok: false, reason: "platform_ceiling" });
    await settleReservation(a.businessId, first.reservationId, 300 * U);
    expect(await reserve(b.businessId, 600 * U, "r3")).toMatchObject({ ok: true });
    const second = await reserve(b.businessId, 100 * U, "r4");
    if (!second.ok) throw new Error("setup");
    await releaseReservation(b.businessId, second.reservationId);
    expect(await reserve(b.businessId, 100 * U, "r5")).toMatchObject({ ok: true });
  });

  it("keeps the generation and embedding ceilings independent", async () => {
    await setPlatformLimit("t", { key: "monthly_generation_tokens_ceiling", value: 1000 * U, reason: "test" });
    expect(await reserve(a.businessId, 1000 * U, "g1")).toMatchObject({ ok: true });
    expect(await reserve(b.businessId, 1 * U, "g2")).toEqual({ ok: false, reason: "platform_ceiling" });
    expect(await reserve(a.businessId, 50 * U, "e1", "embedding")).toMatchObject({ ok: true });
  });

  it("a replay of an in-flight attempt is not blocked by a full platform", async () => {
    await setPlatformLimit("t", { key: "monthly_generation_tokens_ceiling", value: 1000 * U, reason: "test" });
    const first = await reserve(a.businessId, 1000 * U, "p1");
    expect(first).toMatchObject({ ok: true });
    expect(await reserve(a.businessId, 1000 * U, "p1")).toEqual(first);
  });
});

describe("console write", () => {
  it("is super-admin only, bounded, and audited with before and after", async () => {
    gate.role = "operator";
    await expect(setPlatformLimit("t", { key: "max_new_workspaces_per_day", value: 5, reason: "r" })).rejects.toMatchObject({ statusCode: 403 });
    gate.role = "super_admin";
    await expect(setPlatformLimit("t", { key: "nope", value: 5, reason: "r" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(setPlatformLimit("t", { key: "max_new_workspaces_per_day", value: 5 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(setPlatformLimit("t", { key: "max_new_workspaces_per_day", value: -1, reason: "r" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(setPlatformLimit("t", { key: "max_new_workspaces_per_day", value: 1_000_001, reason: "r" })).rejects.toMatchObject({ statusCode: 400 });
    await setPlatformLimit("t", { key: "max_new_workspaces_per_day", value: 900000, reason: "tighten" });
    const audit = await prisma.platformAccessAudit.findFirstOrThrow({ where: { actorUserId: adminId, action: "platform.limit.set", reason: "tighten" } });
    expect(audit.details).toMatchObject({ key: "max_new_workspaces_per_day", before: 1000, after: 900000 });
  });
});

describe("signup capacity", () => {
  const fakeTx = (cap: number | null, created: number) => {
    const calls: string[] = [];
    const tx = {
      $executeRaw: async () => void calls.push("lock"),
      platformLimit: { findUnique: async () => (cap === null ? null : { value: cap }) },
      business: { count: async () => (calls.push("count"), created) },
    };
    return { tx: tx as never, calls };
  };
  it("takes the lock before counting and passes below the cap", async () => {
    const { tx, calls } = fakeTx(10, 9);
    await assertSignupCapacity(tx);
    expect(calls).toEqual(["lock", "count"]);
  });
  it("refuses at the cap with a clear, retryable message", async () => {
    const { tx } = fakeTx(10, 10);
    await expect(assertSignupCapacity(tx)).rejects.toMatchObject({ statusCode: 429, code: "SIGNUPS_PAUSED" });
  });
  it("falls back to the default when no row exists", async () => {
    const { tx } = fakeTx(null, PLATFORM_LIMITS.max_new_workspaces_per_day.def);
    await expect(assertSignupCapacity(tx)).rejects.toMatchObject({ statusCode: 429 });
  });
});
