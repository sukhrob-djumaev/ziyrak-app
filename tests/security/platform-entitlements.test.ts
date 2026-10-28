import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/** L4.1b - assignments, adjustments, baseline and live resolution on a real database (authority replaced by a role switch). */
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
      if (required === "super_admin" && actor.role !== "super_admin") throw new AppError(403, "FORBIDDEN", "Super admin authority is required");
      return prisma.$transaction((tx) => fn(tx, actor));
    },
  };
});
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma/raw-client";
import { archiveVersion, createItem, newDraft, publishVersion } from "@/lib/billing/catalog";
import { assignVersion, endPurchase, setAdjustment } from "@/lib/billing/purchases";
import { assertEntitled, entitledLimit, isEntitled, ensureBaselinePurchase } from "@/lib/billing/entitlements";
import { acquirePlatformLock, releasePlatformLock } from "../helpers/policy-lock";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let ws: SeededBusiness;
let adminId: string;
const keys: string[] = [];
const mk = async (kind: "bundle" | "addon", grants: { capability: string; amount?: number }[]) => {
  const key = `e-${randomUUID().slice(0, 8)}`;
  keys.push(key);
  const v = await createItem("t", { key, kind, terms: { name: key, description: "", grants, priceMinor: 100, currency: "USD", interval: "month" }, reason: "r" });
  return publishVersion("t", { versionId: v.id, expectedRev: v.rev, reason: "r" });
};

beforeAll(async () => {
  await acquirePlatformLock();
  ws = await seedBusiness("entitlements");
  adminId = (await prisma.user.create({ data: { username: `ent-admin-${Date.now()}`, password: "x", name: "A", platformRole: "super_admin" } })).id;
}, 120_000);
afterAll(async () => {
  await prisma.platformAccessAudit.deleteMany({ where: { actorUserId: adminId } });
  await cleanupBusiness(ws.businessId);
  const items = await prisma.catalogItem.findMany({ where: { key: { in: keys } }, select: { id: true } });
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE "CatalogVersion" DISABLE TRIGGER "CatalogVersion_guard"');
    await prisma.catalogVersion.deleteMany({ where: { itemId: { in: items.map((i) => i.id) } } });
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "CatalogVersion" ENABLE TRIGGER "CatalogVersion_guard"');
  }
  await prisma.catalogItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
  await prisma.user.delete({ where: { id: adminId } });
  await releasePlatformLock();
});
beforeEach(() => {
  gate.role = "super_admin";
  gate.userId = adminId;
});

describe("baseline", () => {
  it("a workspace created through the fixtures holds the baseline and keeps today's access", async () => {
    for (const c of ["channel.webchat", "channel.whatsapp_cloud", "automation.rules", "webhooks.outbound", "data.export"]) expect(await isEntitled(ws.businessId, c)).toBe(true);
    expect(await entitledLimit(ws.businessId, "seats.members")).toBe(1000);
  });
  it("ensureBaselinePurchase is idempotent", async () => {
    await prisma.$transaction((tx) => ensureBaselinePurchase(tx, ws.businessId));
    expect(await prisma.workspacePurchase.count({ where: { businessId: ws.businessId, source: "baseline", state: "active" } })).toBe(1);
  });
});

describe("baseline protection", () => {
  it("cannot be archived, re-versioned or re-created from the console", async () => {
    const baseline = await prisma.catalogVersion.findFirstOrThrow({ where: { item: { key: "legacy-baseline" } }, include: { item: true } });
    await expect(archiveVersion("t", { versionId: baseline.id, reason: "r" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(newDraft("t", { itemId: baseline.itemId, reason: "r" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(createItem("t", { key: "legacy-baseline", kind: "bundle", terms: { name: "x", description: "", grants: [{ capability: "data.export" }], priceMinor: 0, currency: "USD", interval: "month" }, reason: "r" })).rejects.toMatchObject({ statusCode: 409 });
    expect((await prisma.catalogVersion.findUniqueOrThrow({ where: { id: baseline.id } })).state).toBe("published");
  });
  it("assigning the same version twice is a clean conflict", async () => {
    const addon = await mk("addon", [{ capability: "automation.rules" }]);
    const first = await assignVersion("t", { businessId: ws.businessId, versionId: addon.id, reason: "dup" });
    await expect(assignVersion("t", { businessId: ws.businessId, versionId: addon.id, reason: "dup" })).rejects.toMatchObject({ statusCode: 409 });
    await endPurchase("t", { purchaseId: first.id, reason: "dup" });
  });
});

describe("assignment", () => {
  it("replacing the bundle changes access at once; an add-on can be held beside it; ending removes it", async () => {
    const small = await mk("bundle", [{ capability: "channel.webchat" }]);
    await expect(assignVersion("t", { businessId: ws.businessId, versionId: small.id, reason: "r" })).rejects.toMatchObject({ statusCode: 409 }); // already holds a bundle
    await assignVersion("t", { businessId: ws.businessId, versionId: small.id, replaceBundle: true, reason: "downgrade test" });
    expect(await isEntitled(ws.businessId, "channel.webchat")).toBe(true);
    expect(await isEntitled(ws.businessId, "data.export")).toBe(false);
    await expect(assertEntitled(ws.businessId, "data.export")).rejects.toMatchObject({ statusCode: 403, code: "ENTITLEMENT_REQUIRED" });
    const addon = await mk("addon", [{ capability: "data.export" }]);
    const a = await assignVersion("t", { businessId: ws.businessId, versionId: addon.id, reason: "add export" });
    expect(await isEntitled(ws.businessId, "data.export")).toBe(true);
    await endPurchase("t", { purchaseId: a.id, reason: "remove export" });
    expect(await isEntitled(ws.businessId, "data.export")).toBe(false);
    expect(await isEntitled(ws.businessId, "channel.webchat")).toBe(true); // other grants untouched
    await expect(endPurchase("t", { purchaseId: a.id, reason: "again" })).rejects.toMatchObject({ statusCode: 409 });
  });
  it("refuses a draft or archived version and a missing workspace; operators and no session change nothing", async () => {
    const d = await createItem("t", { key: (keys[keys.push(`e-${randomUUID().slice(0, 8)}`) - 1]), kind: "addon", terms: { name: "d", description: "", grants: [{ capability: "data.export" }], priceMinor: 0, currency: "USD", interval: "month" }, reason: "r" });
    await expect(assignVersion("t", { businessId: ws.businessId, versionId: d.id, reason: "r" })).rejects.toMatchObject({ statusCode: 409 });
    const before = await prisma.workspacePurchase.count();
    gate.role = "operator";
    await expect(assignVersion("t", { businessId: ws.businessId, versionId: d.id, reason: "r" })).rejects.toMatchObject({ statusCode: 403 });
    gate.role = null;
    await expect(endPurchase("t", { purchaseId: "x", reason: "r" })).rejects.toMatchObject({ statusCode: 401 });
    expect(await prisma.workspacePurchase.count()).toBe(before);
  });
  it("writes one audit row per assignment change with the reason", async () => {
    const rows = await prisma.platformAccessAudit.findMany({ where: { actorUserId: adminId, action: { startsWith: "entitlement." }, businessId: ws.businessId, reason: { not: "dup" } } });
    expect(rows.map((r) => r.action).sort()).toEqual(["entitlement.assign", "entitlement.assign", "entitlement.end"]);
    expect(rows.every((r) => r.reason.length > 0)).toBe(true);
  });
});

describe("adjustments", () => {
  it("add access only until they expire, within 90 days, and never for an unknown capability", async () => {
    const soon = new Date(Date.now() + 1500);
    await setAdjustment("t", { businessId: ws.businessId, capability: "webhooks.outbound", granted: true, expiresAt: soon, reason: "pilot" });
    await setAdjustment("t", { businessId: ws.businessId, capability: "automation.rules", granted: true, expiresAt: new Date(Date.now() + 86_400_000), reason: "pilot" });
    expect(await isEntitled(ws.businessId, "automation.rules")).toBe(true);
    await new Promise((r) => setTimeout(r, 1800));
    expect(await isEntitled(ws.businessId, "webhooks.outbound")).toBe(false); // expired
    await expect(setAdjustment("t", { businessId: ws.businessId, capability: "webhooks.outbound", granted: true, expiresAt: new Date(Date.now() + 100 * 86_400_000), reason: "r" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(setAdjustment("t", { businessId: ws.businessId, capability: "channel.email", granted: true, expiresAt: new Date(Date.now() + 1000), reason: "r" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(setAdjustment("t", { businessId: ws.businessId, capability: "seats.members", granted: true, expiresAt: new Date(Date.now() + 1000), reason: "r" })).rejects.toMatchObject({ statusCode: 400 });
  });
});
