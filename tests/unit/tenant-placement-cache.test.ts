import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma as rawClient } from "@/lib/prisma/raw-client";
import { invalidateTenantPlacement, resolveTenantPlacement } from "@/lib/platform/tenant-placement";
import { closeSharedRedis } from "@/lib/redis/client";

const redisUrl = process.env.REDIS_URL;

type FindUnique = ReturnType<typeof vi.fn>;
const findUnique = () => rawClient.tenantPlacement.findUnique as unknown as FindUnique;

describe("resolveTenantPlacement", () => {
  beforeEach(async () => {
    findUnique().mockReset();
    await invalidateTenantPlacement("biz-1");
    await invalidateTenantPlacement("biz-2");
  });
  afterAll(async () => {
    await closeSharedRedis();
  });

  it("resolves the shared-default placement", async () => {
    findUnique().mockResolvedValue({ businessId: "biz-1", databaseProfileId: "shared-default" });
    await expect(resolveTenantPlacement("biz-1")).resolves.toEqual({ dataConnection: "shared-default" });
  });

  it("throws for a business with no placement row, every time", async () => {
    findUnique().mockResolvedValue(null);
    await expect(resolveTenantPlacement("biz-1")).rejects.toThrow(/No TenantPlacement/);
    await expect(resolveTenantPlacement("biz-1")).rejects.toThrow(/No TenantPlacement/);
    expect(findUnique()).toHaveBeenCalledTimes(2);
  });

  it("throws for an unsupported dedicated profile, and never caches it", async () => {
    findUnique().mockResolvedValue({ businessId: "biz-1", databaseProfileId: "dedicated-1" });
    await expect(resolveTenantPlacement("biz-1")).rejects.toThrow(/Phase 9/);
    await expect(resolveTenantPlacement("biz-1")).rejects.toThrow(/Phase 9/);
    expect(findUnique()).toHaveBeenCalledTimes(2);
  });

  it.skipIf(!redisUrl)("serves repeat lookups from the shared cache, per business", async () => {
    findUnique().mockResolvedValue({ businessId: "biz-1", databaseProfileId: "shared-default" });
    await resolveTenantPlacement("biz-1");
    await resolveTenantPlacement("biz-1");
    expect(findUnique()).toHaveBeenCalledTimes(1);
    await resolveTenantPlacement("biz-2");
    expect(findUnique()).toHaveBeenCalledTimes(2);
  });

  it.skipIf(!redisUrl)("re-reads the control plane after invalidation", async () => {
    findUnique().mockResolvedValue({ businessId: "biz-1", databaseProfileId: "shared-default" });
    await resolveTenantPlacement("biz-1");
    await invalidateTenantPlacement("biz-1");
    await resolveTenantPlacement("biz-1");
    expect(findUnique()).toHaveBeenCalledTimes(2);
  });

  it.skipIf(!!redisUrl)("without Redis, always reads the control plane (no in-process caching)", async () => {
    findUnique().mockResolvedValue({ businessId: "biz-1", databaseProfileId: "shared-default" });
    await resolveTenantPlacement("biz-1");
    await resolveTenantPlacement("biz-1");
    expect(findUnique()).toHaveBeenCalledTimes(2);
  });
});
