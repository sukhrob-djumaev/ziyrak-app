import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/** PLAN.md P2 — meteredCall: reserve before, settle/release/uncertain after, real Postgres. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { meteredCall, AllowanceError } from "@/lib/ai/metered";
import { getAllowanceUsage } from "@/lib/ai/allowance";
import { AIProviderError } from "@/lib/ai/providers/types";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let a: SeededBusiness;
beforeAll(async () => {
  a = await seedBusiness("ai-metered");
});
afterAll(async () => cleanupBusiness(a.businessId));
beforeEach(async () => {
  await prisma.aiUsageReservation.deleteMany({ where: { businessId: a.businessId } });
  await prisma.workspaceAiAllowance.upsert({
    where: { businessId: a.businessId },
    create: { businessId: a.businessId, generationLimitTokens: 1000 },
    update: { generationLimitTokens: 1000, status: "active" },
  });
});

const base = { kind: "generation" as const, managed: true as const };

describe("meteredCall", () => {
  it("passes straight through for an unmanaged workspace and never touches the ledger", async () => {
    const fn = vi.fn().mockResolvedValue({ usage: { totalTokens: 5 } });
    await meteredCall(a.ctx, { kind: "generation", managed: false, estimateTokens: 100, usageOf: (r: { usage: { totalTokens: number } }) => r.usage.totalTokens }, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await prisma.aiUsageReservation.count({ where: { businessId: a.businessId } })).toBe(0);
  });

  it("reserves before the call and settles to actual usage", async () => {
    let during = 0;
    await meteredCall(a.ctx, { ...base, estimateTokens: 400, usageOf: (r: number) => r }, async () => {
      during = (await getAllowanceUsage(a.businessId, "generation")).reserved;
      return 120;
    });
    expect(during).toBe(400);
    expect(await getAllowanceUsage(a.businessId, "generation")).toMatchObject({ used: 120, reserved: 0 });
  });

  it("never calls the provider when exhausted", async () => {
    const fn = vi.fn();
    await expect(meteredCall(a.ctx, { ...base, estimateTokens: 5000, usageOf: () => 0 }, fn)).rejects.toMatchObject({
      name: "AllowanceError",
      reason: "exhausted",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("releases on a failure that cannot have billed (auth, invalid request)", async () => {
    await expect(
      meteredCall(a.ctx, { ...base, estimateTokens: 300, usageOf: () => 0 }, async () => {
        throw new AIProviderError("auth", "bad key", false);
      })
    ).rejects.toBeInstanceOf(AIProviderError);
    expect(await getAllowanceUsage(a.businessId, "generation")).toMatchObject({ used: 0, reserved: 0 });
  });

  it("keeps the bound charged when the outcome is unknown (timeout, unknown error)", async () => {
    await expect(
      meteredCall(a.ctx, { ...base, estimateTokens: 300, usageOf: () => 0 }, async () => {
        throw new AIProviderError("timeout", "slow", true);
      })
    ).rejects.toBeInstanceOf(AIProviderError);
    expect(await getAllowanceUsage(a.businessId, "generation")).toMatchObject({ used: 300, reserved: 0 });
    await expect(
      meteredCall(a.ctx, { ...base, estimateTokens: 100, usageOf: () => 0 }, async () => {
        throw new Error("socket hang up");
      })
    ).rejects.toThrow("socket hang up");
    expect((await getAllowanceUsage(a.businessId, "generation")).used).toBe(400);
  });

  it("each retry attempt reserves again", async () => {
    for (let i = 0; i < 2; i++) {
      await meteredCall(a.ctx, { ...base, estimateTokens: 100, usageOf: () => 100 }, async () => 100);
    }
    expect((await getAllowanceUsage(a.businessId, "generation")).used).toBe(200);
  });

  it("fails closed when the ledger itself fails", async () => {
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("db down"));
    const fn = vi.fn();
    await expect(meteredCall(a.ctx, { ...base, estimateTokens: 10, usageOf: () => 0 }, fn)).rejects.toMatchObject({
      name: "AllowanceError",
      reason: "accounting_unavailable",
    });
    expect(fn).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rejects an over-large prompt for the policy", async () => {
    await expect(
      meteredCall(a.ctx, { ...base, estimateTokens: 10, promptTokens: 50_000, maxPromptTokens: 12_000, usageOf: () => 0 }, vi.fn())
    ).rejects.toBeInstanceOf(AllowanceError);
  });
});
