import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { AppError, NotFoundError } from "@/lib/observability/errors";
import { withPlatformControl } from "@/lib/platform/access/authority";
import { writePlatformAudit } from "@/lib/platform/access/audit";
import { CAPABILITIES, capability } from "./capabilities";

/**
 * L4.1a - super-admin catalog: items (bundle or add-on) with versioned offers. Draft -> published (immutable, DB trigger)
 * -> archived. Archiving stops new assignment only. Every action writes one mandatory platform audit row in the same
 * transaction. Prices are test/display values here; collecting money is L5. Nothing in this module grants access.
 */
const reason = z.string().trim().min(1).max(1000);
const itemKey = z.string().trim().min(2).max(60).regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "lowercase kebab-case");

const grantInput = z.object({ capability: z.string().min(1).max(100), amount: z.number().int().min(1).max(1_000_000_000).optional() }).strict();
const termsInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).default(""),
    grants: z.array(grantInput).max(50),
    priceMinor: z.number().int().min(0).max(100_000_000).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).refine((c) => (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("currency").includes(c), "unknown ISO currency").nullable(),
    interval: z.enum(["month", "year"]).nullable(),
  })
  .strict();

const createItemInput = z.object({ key: itemKey, kind: z.enum(["bundle", "addon"]), terms: termsInput, reason }).strict();
const saveDraftInput = z.object({ versionId: z.string().min(1).max(128), expectedRev: z.number().int().min(1), terms: termsInput, reason }).strict();
const newDraftInput = z.object({ itemId: z.string().min(1).max(128), reason }).strict();
const publishInput = z.object({ versionId: z.string().min(1).max(128), expectedRev: z.number().int().min(1), reason }).strict();
const archiveInput = z.object({ versionId: z.string().min(1).max(128), reason }).strict();

export type Terms = z.infer<typeof termsInput>;

function parse<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError(400, "VALIDATION_ERROR", `Invalid ${what} request`, result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  return result.data;
}

/** Why a draft cannot be published yet. Empty means it can. Pure so the console can show it before the click. */
export function publishProblems(terms: Terms): string[] {
  const problems: string[] = [];
  if (terms.grants.length === 0) problems.push("Grant at least one capability.");
  const seen = new Set<string>();
  for (const g of terms.grants) {
    const def = capability(g.capability);
    if (!def) problems.push(`"${g.capability}" is not a capability the product implements.`);
    else {
      if (def.kind === "boolean" && g.amount !== undefined) problems.push(`"${g.capability}" is on/off and takes no amount.`);
      if (def.kind === "limit" && g.amount === undefined) problems.push(`"${g.capability}" needs an amount.`);
    }
    if (seen.has(g.capability)) problems.push(`"${g.capability}" is granted twice.`);
    seen.add(g.capability);
  }
  const priced = [terms.priceMinor, terms.currency, terms.interval];
  if (priced.some((v) => v === null)) problems.push("Set a price, currency and interval (use 0 for a free offer).");
  return problems;
}

const termsOf = (v: { name: string; description: string; grants: unknown; priceMinor: number | null; currency: string | null; interval: string | null }): Terms => ({
  name: v.name,
  description: v.description,
  grants: (Array.isArray(v.grants) ? v.grants : []) as Terms["grants"],
  priceMinor: v.priceMinor,
  currency: v.currency,
  interval: v.interval as Terms["interval"],
});

const termsData = (t: Terms) => ({
  name: t.name,
  description: t.description,
  grants: t.grants as unknown as Prisma.InputJsonValue,
  priceMinor: t.priceMinor,
  currency: t.currency,
  interval: t.interval,
});

function changedFields(before: Terms, after: Terms): string[] {
  return (Object.keys(after) as (keyof Terms)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

function view(v: Prisma.CatalogVersionGetPayload<object>) {
  return {
    id: v.id,
    itemId: v.itemId,
    version: v.version,
    state: v.state,
    rev: v.rev,
    ...termsOf(v),
    publishedAt: v.publishedAt,
    archivedAt: v.archivedAt,
    createdAt: v.createdAt,
    problems: v.state === "draft" ? publishProblems(termsOf(v)) : [],
  };
}

export async function readCatalogConsole(token: string) {
  return withPlatformControl(token, "super_admin", async (tx) => {
    const items = await tx.catalogItem.findMany({ orderBy: { createdAt: "asc" }, include: { versions: { orderBy: { version: "desc" } } } });
    return {
      capabilities: CAPABILITIES.map((c) => ({ key: c.key, label: c.label, kind: c.kind })),
      items: items.map((i) => ({ id: i.id, key: i.key, kind: i.kind, versions: i.versions.map(view) })),
    };
  });
}

export async function createItem(token: string, input: unknown) {
  const r = parse(createItemInput, input, "catalog item");
  return withPlatformControl(token, "super_admin", async (tx, actor) => {
    if (await tx.catalogItem.findUnique({ where: { key: r.key } })) throw new AppError(409, "CONFLICT", "An item with this key already exists");
    const item = await tx.catalogItem.create({ data: { key: r.key, kind: r.kind } });
    const v = await tx.catalogVersion.create({ data: { itemId: item.id, version: 1, createdBy: actor.userId, ...termsData(r.terms) } });
    await writePlatformAudit(tx, { actorUserId: actor.userId, action: "catalog.item.create", reason: r.reason, details: { itemKey: item.key, kind: item.kind, version: 1, versionId: v.id } });
    return view(v);
  });
}

async function mustFind(tx: Prisma.TransactionClient, versionId: string) {
  const v = await tx.catalogVersion.findUnique({ where: { id: versionId }, include: { item: true } });
  if (!v) throw new NotFoundError("Catalog version");
  return v;
}

export async function saveDraft(token: string, input: unknown) {
  const r = parse(saveDraftInput, input, "catalog draft");
  return withPlatformControl(token, "super_admin", async (tx, actor) => {
    const v = await mustFind(tx, r.versionId);
    if (v.state !== "draft") throw new AppError(409, "CONFLICT", "Only a draft can be edited; create a new draft to change published terms");
    // Compare-and-set on rev: a stale browser tab cannot overwrite a newer save.
    const updated = await tx.catalogVersion.updateMany({ where: { id: v.id, rev: r.expectedRev, state: "draft" }, data: { ...termsData(r.terms), rev: { increment: 1 } } });
    if (updated.count !== 1) throw new AppError(409, "CONFLICT", "This draft changed since you opened it. Reload and try again");
    await writePlatformAudit(tx, { actorUserId: actor.userId, action: "catalog.draft.save", reason: r.reason, details: { itemKey: v.item.key, version: v.version, changed: changedFields(termsOf(v), r.terms) } });
    return view(await tx.catalogVersion.findUniqueOrThrow({ where: { id: v.id } }));
  });
}

export async function newDraft(token: string, input: unknown) {
  const r = parse(newDraftInput, input, "new draft");
  return withPlatformControl(token, "super_admin", async (tx, actor) => {
    const item = await tx.catalogItem.findUnique({ where: { id: r.itemId }, include: { versions: { orderBy: { version: "desc" } } } });
    if (!item) throw new NotFoundError("Catalog item");
    if (item.versions.some((x) => x.state === "draft")) throw new AppError(409, "CONFLICT", "This item already has an open draft");
    const base = item.versions.find((x) => x.state === "published") ?? item.versions[0];
    const next = (item.versions[0]?.version ?? 0) + 1;
    const v = await tx.catalogVersion.create({ data: { itemId: item.id, version: next, createdBy: actor.userId, ...termsData(termsOf(base)) } });
    await writePlatformAudit(tx, { actorUserId: actor.userId, action: "catalog.draft.new", reason: r.reason, details: { itemKey: item.key, version: next, copiedFrom: base.version } });
    return view(v);
  });
}

export async function publishVersion(token: string, input: unknown) {
  const r = parse(publishInput, input, "publish");
  return withPlatformControl(token, "super_admin", async (tx, actor) => {
    const v = await mustFind(tx, r.versionId);
    if (v.state !== "draft") throw new AppError(409, "CONFLICT", "Only a draft can be published");
    if (v.rev !== r.expectedRev) throw new AppError(409, "CONFLICT", "This draft changed since you opened it. Reload and try again");
    const problems = publishProblems(termsOf(v));
    if (problems.length) throw new AppError(400, "VALIDATION_ERROR", "This draft cannot be published", problems);
    const claimed = await tx.catalogVersion.updateMany({ where: { id: v.id, rev: r.expectedRev, state: "draft" }, data: { state: "published", publishedAt: new Date(), publishedBy: actor.userId } });
    if (claimed.count !== 1) throw new AppError(409, "CONFLICT", "This draft changed since you opened it. Reload and try again");
    const updated = await tx.catalogVersion.findUniqueOrThrow({ where: { id: v.id } });
    await writePlatformAudit(tx, { actorUserId: actor.userId, action: "catalog.version.publish", reason: r.reason, details: { itemKey: v.item.key, version: v.version, grants: termsOf(v).grants, priceMinor: v.priceMinor, currency: v.currency, interval: v.interval } });
    return view(updated);
  });
}

export async function archiveVersion(token: string, input: unknown) {
  const r = parse(archiveInput, input, "archive");
  return withPlatformControl(token, "super_admin", async (tx, actor) => {
    const v = await mustFind(tx, r.versionId);
    if (v.state !== "published") throw new AppError(409, "CONFLICT", "Only a published version can be archived");
    const claimed = await tx.catalogVersion.updateMany({ where: { id: v.id, state: "published" }, data: { state: "archived", archivedAt: new Date() } });
    if (claimed.count !== 1) throw new AppError(409, "CONFLICT", "Only a published version can be archived");
    const updated = await tx.catalogVersion.findUniqueOrThrow({ where: { id: v.id } });
    await writePlatformAudit(tx, { actorUserId: actor.userId, action: "catalog.version.archive", reason: r.reason, details: { itemKey: v.item.key, version: v.version } });
    return view(updated);
  });
}
