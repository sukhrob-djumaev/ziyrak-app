import { z } from "zod";
import { AppError, NotFoundError } from "@/lib/observability/errors";
import { withPlatformControl } from "@/lib/platform/access/authority";
import { writePlatformAudit } from "@/lib/platform/access/audit";
import { lockTenantWrites } from "@/lib/tenancy/work-lifecycle";
import { capability } from "./capabilities";

/**
 * L4.1b - super-admin assignment of catalog versions to workspaces (test/manual source only; payment-sourced purchases
 * arrive with L5) and expiring adjustments. Every change takes the workspace write fence before it can reduce access, so
 * delayed work that re-checks entitlements sees either the old or the new state, never a torn one. One active bundle per workspace.
 */
const reason = z.string().trim().min(1).max(1000);
const id = z.string().min(1).max(128);
const assignInput = z.object({ businessId: id, versionId: id, quantity: z.number().int().min(1).max(100_000).default(1), replaceBundle: z.boolean().default(false), reason }).strict();
const endInput = z.object({ purchaseId: id, reason }).strict();
const adjustInput = z
  .object({ businessId: id, capability: z.string().min(1).max(100), granted: z.boolean().optional(), amount: z.number().int().min(1).max(1_000_000_000).optional(), expiresAt: z.coerce.date(), reason })
  .strict();
const MAX_ADJUSTMENT_MS = 90 * 24 * 3600 * 1000;

function parse<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new AppError(400, "VALIDATION_ERROR", `Invalid ${what} request`);
  return r.data;
}

export async function assignVersion(token: string, input: unknown) {
  const r = parse(assignInput, input, "assignment");
  return withPlatformControl(token, "super_admin", async (tx, actor) => {
    const business = await tx.business.findUnique({ where: { id: r.businessId }, select: { id: true } });
    if (!business) throw new NotFoundError("Workspace");
    await lockTenantWrites(tx, r.businessId);
    const version = await tx.catalogVersion.findUnique({ where: { id: r.versionId }, include: { item: true } });
    if (!version) throw new NotFoundError("Catalog version");
    if (version.state !== "published") throw new AppError(409, "CONFLICT", "Only a published version can be assigned");
    if (r.quantity > 1 && version.item.kind === "bundle") throw new AppError(400, "VALIDATION_ERROR", "A bundle is held once");
    if (version.item.kind === "bundle") {
      const current = await tx.workspacePurchase.findMany({ where: { businessId: r.businessId, state: "active", version: { item: { kind: "bundle" } } } });
      if (current.length > 0 && !r.replaceBundle) throw new AppError(409, "CONFLICT", "This workspace already holds a bundle; replace it explicitly");
      if (current.length > 0)
        await tx.workspacePurchase.updateMany({ where: { id: { in: current.map((c) => c.id) } }, data: { state: "ended", endsAt: new Date() } });
    }
    const purchase = await tx.workspacePurchase.create({
      data: { businessId: r.businessId, versionId: version.id, quantity: r.quantity, source: "manual_test", reason: r.reason, createdBy: actor.userId },
    });
    await writePlatformAudit(tx, { actorUserId: actor.userId, action: "entitlement.assign", reason: r.reason, businessId: r.businessId, details: { itemKey: version.item.key, version: version.version, quantity: r.quantity, replacedBundle: r.replaceBundle, purchaseId: purchase.id } });
    return { id: purchase.id, versionId: purchase.versionId, quantity: purchase.quantity, state: purchase.state };
  });
}

export async function endPurchase(token: string, input: unknown) {
  const r = parse(endInput, input, "end purchase");
  return withPlatformControl(token, "super_admin", async (tx, actor) => {
    const p = await tx.workspacePurchase.findUnique({ where: { id: r.purchaseId }, include: { version: { include: { item: true } } } });
    if (!p) throw new NotFoundError("Purchase");
    await lockTenantWrites(tx, p.businessId);
    const claimed = await tx.workspacePurchase.updateMany({ where: { id: p.id, state: "active" }, data: { state: "ended", endsAt: new Date() } });
    if (claimed.count !== 1) throw new AppError(409, "CONFLICT", "This purchase has already ended");
    await writePlatformAudit(tx, { actorUserId: actor.userId, action: "entitlement.end", reason: r.reason, businessId: p.businessId, details: { itemKey: p.version.item.key, version: p.version.version, purchaseId: p.id, source: p.source } });
    return { id: p.id, state: "ended" };
  });
}

export async function setAdjustment(token: string, input: unknown) {
  const r = parse(adjustInput, input, "adjustment");
  const def = capability(r.capability);
  if (!def) throw new AppError(400, "VALIDATION_ERROR", "Unknown capability");
  if (def.kind === "boolean" ? r.granted !== true || r.amount !== undefined : r.amount === undefined || r.granted !== undefined)
    throw new AppError(400, "VALIDATION_ERROR", "Use granted for on/off capabilities and amount for limits");
  const lifetime = r.expiresAt.getTime() - Date.now();
  if (lifetime <= 0 || lifetime > MAX_ADJUSTMENT_MS) throw new AppError(400, "VALIDATION_ERROR", "An adjustment must expire within 90 days");
  return withPlatformControl(token, "super_admin", async (tx, actor) => {
    const business = await tx.business.findUnique({ where: { id: r.businessId }, select: { id: true } });
    if (!business) throw new NotFoundError("Workspace");
    await lockTenantWrites(tx, r.businessId);
    const a = await tx.entitlementAdjustment.create({
      data: { businessId: r.businessId, capability: r.capability, granted: r.granted ?? null, amount: r.amount ?? null, expiresAt: r.expiresAt, reason: r.reason, createdBy: actor.userId },
    });
    await writePlatformAudit(tx, { actorUserId: actor.userId, action: "entitlement.adjust", reason: r.reason, businessId: r.businessId, details: { capability: r.capability, granted: r.granted ?? null, amount: r.amount ?? null, expiresAt: r.expiresAt.toISOString(), adjustmentId: a.id } });
    return { id: a.id, capability: a.capability, expiresAt: a.expiresAt };
  });
}
