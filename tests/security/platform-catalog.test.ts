import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * L4.1a - catalog lifecycle on a real database. The platform authority gate itself is covered by platform-authority.test.ts;
 * here it is replaced by a role switch (same approach as platform-ai-service.test.ts) so files can run in parallel.
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
      if (required === "super_admin" && actor.role !== "super_admin") throw new AppError(403, "FORBIDDEN", "Super admin authority is required");
      return prisma.$transaction((tx) => fn(tx, actor));
    },
  };
});
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma/raw-client";
import { archiveVersion, createItem, newDraft, publishVersion, readCatalogConsole, saveDraft } from "@/lib/billing/catalog";
import { acquirePlatformLock, releasePlatformLock } from "../helpers/policy-lock";

let adminId: string;
const keys: string[] = [];
const terms = { name: "Inbox", description: "Web Chat + AI", grants: [{ capability: "channel.webchat" }], priceMinor: 1900, currency: "MYR", interval: "month" as const };
const newKey = () => {
  const k = `t-${randomUUID().slice(0, 8)}`;
  keys.push(k);
  return k;
};

beforeAll(async () => {
  await acquirePlatformLock();
  adminId = (await prisma.user.create({ data: { username: `cat-admin-${Date.now()}`, password: "x", name: "Admin", platformRole: "super_admin" } })).id;
}, 120_000);
afterAll(async () => {
  const items = await prisma.catalogItem.findMany({ where: { key: { in: keys } }, select: { id: true } });
  // Published versions are immutable and undeletable by design, so cleanup lifts the guard on this table for the duration of
  // this delete only (restored in finally). Other files never touch catalog tables.
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE "CatalogVersion" DISABLE TRIGGER "CatalogVersion_guard"');
    await prisma.catalogVersion.deleteMany({ where: { itemId: { in: items.map((i) => i.id) } } });
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "CatalogVersion" ENABLE TRIGGER "CatalogVersion_guard"');
  }
  await prisma.catalogItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
  await prisma.platformAccessAudit.deleteMany({ where: { actorUserId: adminId } });
  await prisma.user.delete({ where: { id: adminId } });
  await releasePlatformLock();
});
beforeEach(() => {
  gate.role = "super_admin";
  gate.userId = adminId;
});

describe("catalog lifecycle", () => {
  it("creates a draft, publishes it, and records one audit row per action with the reason", async () => {
    const created = await createItem("t", { key: newKey(), kind: "bundle", terms, reason: "new base bundle" });
    expect(created.state).toBe("draft");
    expect(created.problems).toEqual([]);
    const published = await publishVersion("t", { versionId: created.id, expectedRev: created.rev, reason: "go" });
    expect(published.state).toBe("published");
    const key = created.itemId;
    const audit = await prisma.platformAccessAudit.findMany({ where: { actorUserId: adminId, action: { startsWith: "catalog." }, details: { path: ["versionId"], equals: created.id } } });
    const forItem = await prisma.platformAccessAudit.findMany({ where: { actorUserId: adminId, action: { startsWith: "catalog." } }, orderBy: { createdAt: "asc" } });
    expect(key).toBeTruthy();
    expect(audit).toHaveLength(1); // the create row carries the version id
    expect(forItem.filter((a) => a.action === "catalog.version.publish")).toHaveLength(1);
    expect(forItem.every((a) => a.reason === "new base bundle" || a.reason === "go")).toBe(true);
  });

  it("refuses to publish unknown capabilities, an amount on an on/off key, or an incomplete price - and stays a draft", async () => {
    const bad = await createItem("t", { key: newKey(), kind: "addon", terms: { ...terms, grants: [{ capability: "channel.email" }], priceMinor: null }, reason: "r" });
    await expect(publishVersion("t", { versionId: bad.id, expectedRev: bad.rev, reason: "r" })).rejects.toMatchObject({ statusCode: 400 });
    expect((await prisma.catalogVersion.findUniqueOrThrow({ where: { id: bad.id } })).state).toBe("draft");
  });

  it("makes a published version immutable at the database, but lets it be archived", async () => {
    const c = await createItem("t", { key: newKey(), kind: "bundle", terms, reason: "r" });
    await publishVersion("t", { versionId: c.id, expectedRev: c.rev, reason: "r" });
    for (const data of [{ priceMinor: 1 }, { grants: [] }, { name: "x" }, { state: "draft" }]) {
      await expect(prisma.catalogVersion.update({ where: { id: c.id }, data })).rejects.toThrow(/immutable/);
    }
    await expect(prisma.catalogVersion.delete({ where: { id: c.id } })).rejects.toThrow(/cannot be deleted/);
    await expect(saveDraft("t", { versionId: c.id, expectedRev: c.rev, terms, reason: "r" })).rejects.toMatchObject({ statusCode: 409 });
    const archived = await archiveVersion("t", { versionId: c.id, reason: "retire" });
    expect(archived.state).toBe("archived");
    expect((await prisma.catalogVersion.findUniqueOrThrow({ where: { id: c.id } })).priceMinor).toBe(1900); // terms kept
  });

  it("changes a price only through a new version; the old version keeps its terms", async () => {
    const c = await createItem("t", { key: newKey(), kind: "bundle", terms, reason: "r" });
    await publishVersion("t", { versionId: c.id, expectedRev: c.rev, reason: "r" });
    const d = await newDraft("t", { itemId: c.itemId, reason: "price change" });
    expect(d.version).toBe(2);
    expect(d.priceMinor).toBe(1900);
    await expect(newDraft("t", { itemId: c.itemId, reason: "again" })).rejects.toMatchObject({ statusCode: 409 }); // one open draft
    const saved = await saveDraft("t", { versionId: d.id, expectedRev: d.rev, terms: { ...terms, priceMinor: 2400 }, reason: "raise" });
    await publishVersion("t", { versionId: d.id, expectedRev: saved.rev, reason: "r" });
    expect((await prisma.catalogVersion.findUniqueOrThrow({ where: { id: c.id } })).priceMinor).toBe(1900);
    expect((await prisma.catalogVersion.findUniqueOrThrow({ where: { id: d.id } })).priceMinor).toBe(2400);
  });

  it("rejects a stale edit and a stale publish (optimistic concurrency)", async () => {
    const c = await createItem("t", { key: newKey(), kind: "bundle", terms, reason: "r" });
    await saveDraft("t", { versionId: c.id, expectedRev: c.rev, terms: { ...terms, name: "Second" }, reason: "r" });
    await expect(saveDraft("t", { versionId: c.id, expectedRev: c.rev, terms: { ...terms, name: "Stale" }, reason: "r" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(publishVersion("t", { versionId: c.id, expectedRev: c.rev, reason: "r" })).rejects.toMatchObject({ statusCode: 409 });
    expect((await prisma.catalogVersion.findUniqueOrThrow({ where: { id: c.id } })).name).toBe("Second");
  });

  it("keeps the lifecycle rules at the database even against direct SQL", async () => {
    const c = await createItem("t", { key: newKey(), kind: "bundle", terms, reason: "r" });
    // draft -> archived, and publishing without a price, are refused by the database itself
    await expect(prisma.catalogVersion.update({ where: { id: c.id }, data: { state: "archived" } })).rejects.toThrow(/cannot be archived/);
    await expect(prisma.catalogVersion.update({ where: { id: c.id }, data: { state: "published", priceMinor: null } })).rejects.toThrow(/sellable|violates check/);
    await expect(prisma.catalogVersion.update({ where: { id: c.id }, data: { state: "bogus" } })).rejects.toThrow(/check/i);
    await publishVersion("t", { versionId: c.id, expectedRev: c.rev, reason: "r" });
    // published: identity columns, rev and the archive stamp cannot be rewritten; item key and kind are permanent
    await expect(prisma.catalogVersion.update({ where: { id: c.id }, data: { rev: 99, state: "archived", archivedAt: new Date() } })).rejects.toThrow(/immutable/);
    await expect(prisma.catalogVersion.update({ where: { id: c.id }, data: { state: "archived", archivedAt: null } })).rejects.toThrow(/check|sellable/i);
    await expect(prisma.catalogItem.update({ where: { id: c.itemId }, data: { kind: "addon" } })).rejects.toThrow(/permanent/);
    await expect(prisma.catalogItem.update({ where: { id: c.itemId }, data: { key: "renamed" } })).rejects.toThrow(/permanent/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE "CatalogVersion" CASCADE')).rejects.toThrow(/truncated/);
    await archiveVersion("t", { versionId: c.id, reason: "r" });
    await expect(prisma.catalogVersion.update({ where: { id: c.id }, data: { state: "published" } })).rejects.toThrow(/immutable/); // archived is final
  });

  it("refuses to publish a price whose currency the billing policy does not allow", async () => {
    const d = await createItem("t", { key: newKey(), kind: "bundle", terms: { ...terms, currency: "USD" }, reason: "r" });
    await expect(publishVersion("t", { versionId: d.id, expectedRev: d.rev, reason: "go" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an unknown ISO currency", async () => {
    await expect(createItem("t", { key: newKey(), kind: "bundle", terms: { ...terms, currency: "XYZ" }, reason: "r" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a duplicate key and a malformed key", async () => {
    const key = newKey();
    await createItem("t", { key, kind: "bundle", terms, reason: "r" });
    await expect(createItem("t", { key, kind: "bundle", terms, reason: "r" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(createItem("t", { key: "Bad Key", kind: "bundle", terms, reason: "r" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("is refused to operators and to no session, changing nothing", async () => {
    const before = await prisma.catalogItem.count();
    gate.role = "operator";
    await expect(createItem("t", { key: newKey(), kind: "bundle", terms, reason: "r" })).rejects.toMatchObject({ statusCode: 403 });
    await expect(readCatalogConsole("t")).rejects.toMatchObject({ statusCode: 403 });
    gate.role = null;
    await expect(createItem("t", { key: newKey(), kind: "bundle", terms, reason: "r" })).rejects.toMatchObject({ statusCode: 401 });
    expect(await prisma.catalogItem.count()).toBe(before);
  });
});
