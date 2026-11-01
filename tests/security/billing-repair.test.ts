import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/** L5.2 - the super-admin repair re-reads the provider, applies it, resolves repairable incidents and audits; nothing else. */
const gate = vi.hoisted(() => ({ role: "super_admin" as "super_admin" | "operator", userId: "" }));
vi.mock("@/lib/platform/access/authority", async () => {
  const { prisma } = await import("@/lib/prisma/raw-client");
  const { AppError } = await import("@/lib/observability/errors");
  return {
    withPlatformControl: async (_t: string, required: string, fn: (tx: unknown, actor: unknown) => Promise<unknown>) => {
      if (required === "super_admin" && gate.role !== "super_admin") throw new AppError(403, "FORBIDDEN", "Super admin authority is required");
      return prisma.$transaction((tx) => fn(tx, { userId: gate.userId, role: gate.role }));
    },
  };
});
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { repairProvision } from "@/lib/billing/repair";
import type { PaymentProvider, ProviderSubscription } from "@/lib/billing/providers/types";

const tag = `brp-${Date.now()}`;
let biz: string, bare: string, adminId: string;
const getSubscription = vi.fn(async (r: string): Promise<ProviderSubscription> => ({
  ref: r, customerRef: `${tag}-cus`, status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: new Date(Date.now() + 86_400_000), currency: "MYR", items: [], metadata: {}, fetchedAt: new Date(),
}));
const deps = { provider: { name: `${tag}-prov`, getSubscription } as unknown as PaymentProvider, mode: "test" as const };

beforeAll(async () => {
  adminId = (await prisma.user.create({ data: { username: `${tag}-admin`, password: "x", name: "A", platformRole: "super_admin" } })).id;
  gate.userId = adminId;
  biz = (await prisma.business.create({ data: { name: tag, slug: tag } })).id;
  bare = (await prisma.business.create({ data: { name: `${tag}-bare`, slug: `${tag}-bare` } })).id;
  await prisma.billingSubscription.create({ data: { businessId: biz, provider: deps.provider.name, subscriptionRef: `${tag}-sub`, customerRef: `${tag}-cus`, status: "incomplete", currency: "MYR" } });
  await prisma.billingIncident.createMany({
    data: [
      { businessId: biz, kind: "paid_not_provisioned", detail: "d1" },
      { businessId: biz, kind: "paid_after_end", detail: "d2" },
    ],
  });
});
afterAll(async () => {
  await prisma.platformAccessAudit.deleteMany({ where: { actorUserId: adminId } });
  await prisma.billingIncident.deleteMany({ where: { businessId: biz } });
  await prisma.billingSubscription.deleteMany({ where: { businessId: biz } });
  await prisma.business.deleteMany({ where: { id: { in: [biz, bare] } } });
  await prisma.user.delete({ where: { id: adminId } });
});

describe("repairProvision", () => {
  it("is refused for anyone but a super admin and changes nothing", async () => {
    gate.role = "operator";
    await expect(repairProvision("t", { businessId: biz, reason: "r" }, deps)).rejects.toMatchObject({ statusCode: 403 });
    expect(getSubscription).not.toHaveBeenCalled();
    gate.role = "super_admin";
  });

  it("requires a reason and refuses a workspace with nothing live", async () => {
    await expect(repairProvision("t", { businessId: biz, reason: " " }, deps)).rejects.toMatchObject({ statusCode: 400 });
    await expect(repairProvision("t", { businessId: bare, reason: "r" }, deps)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("applies the provider's answer, resolves only repairable incidents and writes one audit row", async () => {
    const out = await repairProvision("t", { businessId: biz, reason: "paid but nothing granted" }, deps);
    expect(out).toEqual({ subscriptions: 1, incidentsResolved: 1 });
    expect((await prisma.billingSubscription.findFirstOrThrow({ where: { businessId: biz } })).status).toBe("active");
    const inc = await prisma.billingIncident.findMany({ where: { businessId: biz }, orderBy: { detail: "asc" } });
    expect(inc.map((i) => i.state)).toEqual(["resolved", "open"]);
    expect(await prisma.platformAccessAudit.count({ where: { actorUserId: adminId, action: "billing.repair", businessId: biz } })).toBe(1);
  });

  it("leaves the incident open when the provider cannot be read", async () => {
    await prisma.billingIncident.create({ data: { businessId: biz, kind: "unbound_ref", detail: "d3" } });
    getSubscription.mockRejectedValueOnce(new Error("provider down"));
    await expect(repairProvision("t", { businessId: biz, reason: "r" }, deps)).rejects.toThrow("provider down");
    expect(await prisma.billingIncident.count({ where: { businessId: biz, kind: "unbound_ref", state: "open" } })).toBe(1);
  });
});
