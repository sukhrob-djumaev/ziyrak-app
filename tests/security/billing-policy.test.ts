import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/** L5.0 - the console-editable billing policy: defaults, validation, compare-and-set and audit. */
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
import { DEFAULT_BILLING_POLICY, readBillingPolicy, policyProblemsForTerms } from "@/lib/billing/policy";
import { saveBillingPolicy } from "@/lib/billing/policy-console";
import { acquirePlatformLock, releasePlatformLock } from "../helpers/policy-lock";

let adminId: string;
const valid = {
  expectedRev: 0,
  graceDays: 10,
  trialDays: 0,
  holdRetentionDays: 60,
  currencies: ["MYR"],
  intervals: ["month", "year"],
  refundPolicyText: "Refunds are reviewed case by case.",
  refundPolicyUrl: "https://example.com/refunds",
  supportContact: "support@example.com",
  taxDisplay: "none",
  reason: "initial policy",
};

beforeAll(async () => {
  await acquirePlatformLock();
  adminId = (await prisma.user.create({ data: { username: `pol-admin-${Date.now()}`, password: "x", name: "A", platformRole: "super_admin" } })).id;
}, 120_000);
afterAll(async () => {
  await prisma.billingPolicy.deleteMany({});
  await prisma.platformAccessAudit.deleteMany({ where: { actorUserId: adminId } });
  await prisma.user.delete({ where: { id: adminId } });
  await releasePlatformLock();
});
beforeEach(async () => {
  gate.role = "super_admin";
  gate.userId = adminId;
  await prisma.billingPolicy.deleteMany({});
});

describe("billing policy", () => {
  it("returns the code defaults at revision 0 when nothing is saved", async () => {
    const p = await readBillingPolicy(prisma);
    expect(p).toMatchObject({ rev: 0, graceDays: 7, trialDays: 0, holdRetentionDays: 60, currencies: ["MYR"], intervals: ["month", "year"] });
    expect(p).toMatchObject({ ...DEFAULT_BILLING_POLICY, rev: 0 });
  });

  it("saves, bumps the revision and writes one audit row with before and after", async () => {
    const saved = await saveBillingPolicy("t", valid);
    expect(saved).toMatchObject({ rev: 1, graceDays: 10 });
    expect(await readBillingPolicy(prisma)).toMatchObject({ rev: 1, graceDays: 10, refundPolicyUrl: "https://example.com/refunds" });
    const audit = await prisma.platformAccessAudit.findMany({ where: { actorUserId: adminId, action: "billing.policy.save" } });
    expect(audit).toHaveLength(1);
    expect(audit[0].reason).toBe("initial policy");
    expect(audit[0].details).toMatchObject({ before: { graceDays: 7 }, after: { graceDays: 10 } });
  });

  it("rejects a stale revision so a second tab cannot overwrite a newer save", async () => {
    await saveBillingPolicy("t", valid);
    await expect(saveBillingPolicy("t", { ...valid, graceDays: 3 })).rejects.toMatchObject({ statusCode: 409 });
    expect((await readBillingPolicy(prisma)).graceDays).toBe(10);
    await expect(saveBillingPolicy("t", { ...valid, expectedRev: 1, graceDays: 3 })).resolves.toMatchObject({ rev: 2, graceDays: 3 });
  });

  it("lets only one of two concurrent saves at the same revision win", async () => {
    const results = await Promise.allSettled([
      saveBillingPolicy("t", { ...valid, graceDays: 4 }),
      saveBillingPolicy("t", { ...valid, graceDays: 5 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await readBillingPolicy(prisma)).rev).toBe(1);
  });

  it.each([
    ["a trial (no trial lifecycle exists)", { trialDays: 7 }],
    ["grace above 30 days", { graceDays: 31 }],
    ["negative grace", { graceDays: -1 }],
    ["retention below 30 days", { holdRetentionDays: 29 }],
    ["retention above 365 days", { holdRetentionDays: 366 }],
    ["an unsupported currency", { currencies: ["XXX"] }],
    ["no currency", { currencies: [] }],
    ["an unsupported interval", { intervals: ["week"] }],
    ["a non-https refund URL", { refundPolicyUrl: "http://example.com/r" }],
    ["a javascript URL", { refundPolicyUrl: "javascript:alert(1)" }],
    ["an unknown tax mode", { taxDisplay: "magic" }],
    ["an oversized refund text", { refundPolicyText: "x".repeat(2001) }],
    ["an unknown field", { extra: 1 }],
    ["a missing reason", { reason: "" }],
  ])("rejects %s and saves nothing", async (_n, patch) => {
    await expect(saveBillingPolicy("t", { ...valid, ...patch })).rejects.toMatchObject({ statusCode: 400 });
    expect(await prisma.billingPolicy.count()).toBe(0);
  });

  it("requires super admin authority", async () => {
    gate.role = "operator";
    await expect(saveBillingPolicy("t", valid)).rejects.toMatchObject({ statusCode: 403 });
    expect(await prisma.billingPolicy.count()).toBe(0);
  });

  it("flags a price whose currency or interval the policy does not allow", () => {
    const policy = { ...DEFAULT_BILLING_POLICY, rev: 0 };
    expect(policyProblemsForTerms({ currency: "MYR", interval: "month" }, policy)).toEqual([]);
    expect(policyProblemsForTerms({ currency: "USD", interval: "month" }, policy)).toHaveLength(1);
    expect(policyProblemsForTerms({ currency: "MYR", interval: "year" }, { ...policy, intervals: ["month"] })).toHaveLength(1);
    expect(policyProblemsForTerms({ currency: null, interval: null }, policy)).toEqual([]);
  });
});
