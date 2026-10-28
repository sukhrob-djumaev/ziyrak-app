import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma/raw-client";
import { AppError } from "@/lib/observability/errors";
import { capability } from "./capabilities";

/**
 * What a workspace may use, derived only from server-side records: active purchases of published catalog versions plus
 * unexpired administrative adjustments. Pure composition (`composeEntitlements`) over a thin loader. It answers one question
 * ("is this capability available, and how much") and never grants a role, a channel scope or a tool approval.
 */
export interface Source {
  kind: "purchase" | "adjustment";
  id: string;
  versionId?: string;
  amount?: number;
}
export interface Effective {
  capability: string;
  granted: boolean;
  /** Combined amount for limit capabilities. */
  limit: number;
  provenance: Source[];
}
export interface PurchaseInput {
  id: string;
  versionId: string;
  quantity: number;
  grants: { capability: string; amount?: number }[];
}
export interface AdjustmentInput {
  id: string;
  capability: string;
  granted: boolean | null;
  amount: number | null;
}

export function composeEntitlements(purchases: PurchaseInput[], adjustments: AdjustmentInput[]): { effective: Map<string, Effective>; ignored: string[] } {
  const effective = new Map<string, Effective>();
  const ignored: string[] = [];
  const slot = (key: string): Effective => {
    let e = effective.get(key);
    if (!e) effective.set(key, (e = { capability: key, granted: false, limit: 0, provenance: [] }));
    return e;
  };
  const add = (key: string, source: Source, grantsAccess: boolean, amount: number | undefined) => {
    const def = capability(key);
    // A retired or unknown key in an old version is never granted; it is reported so a migration can be written.
    if (!def) return void ignored.push(key);
    const e = slot(key);
    if (def.kind === "boolean") {
      if (grantsAccess) {
        e.granted = true;
        e.provenance.push(source);
      }
      return;
    }
    if (amount === undefined) return;
    e.limit = def.combine === "max" ? Math.max(e.limit, amount) : e.limit + amount;
    e.granted = e.limit > 0;
    e.provenance.push({ ...source, amount });
  };
  for (const p of purchases)
    for (const g of p.grants) add(g.capability, { kind: "purchase", id: p.id, versionId: p.versionId }, true, g.amount === undefined ? undefined : g.amount * p.quantity);
  for (const a of adjustments) add(a.capability, { kind: "adjustment", id: a.id }, a.granted === true, a.amount ?? undefined);
  return { effective, ignored };
}

type Db = Pick<Prisma.TransactionClient, "workspacePurchase" | "entitlementAdjustment">;

/** Live read (no cache): a revocation is visible to the very next privileged operation. */
export async function resolveEntitlements(businessId: string, now: Date = new Date(), db: Db = prisma) {
  const [purchases, adjustments] = await Promise.all([
    db.workspacePurchase.findMany({
      where: { businessId, state: "active", startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      include: { version: { select: { grants: true } } },
    }),
    db.entitlementAdjustment.findMany({ where: { businessId, expiresAt: { gt: now } } }),
  ]);
  return composeEntitlements(
    purchases.map((p) => ({ id: p.id, versionId: p.versionId, quantity: p.quantity, grants: (Array.isArray(p.version.grants) ? p.version.grants : []) as PurchaseInput["grants"] })),
    adjustments.map((a) => ({ id: a.id, capability: a.capability, granted: a.granted, amount: a.amount }))
  );
}

export class EntitlementRequiredError extends AppError {
  constructor(public readonly capabilityKey: string) {
    super(403, "ENTITLEMENT_REQUIRED", "This workspace's current package does not include this feature.", { capability: capabilityKey });
  }
}

export async function isEntitled(businessId: string, key: string, db?: Db): Promise<boolean> {
  return (await resolveEntitlements(businessId, new Date(), db)).effective.get(key)?.granted === true;
}

/** Throws ENTITLEMENT_REQUIRED. Add this to the permission check; it never replaces it. */
export async function assertEntitled(businessId: string, key: string, db?: Db): Promise<void> {
  if (!(await isEntitled(businessId, key, db))) throw new EntitlementRequiredError(key);
}

export async function entitledLimit(businessId: string, key: string, db?: Db): Promise<number> {
  return (await resolveEntitlements(businessId, new Date(), db)).effective.get(key)?.limit ?? 0;
}

export { BASELINE_ITEM_KEY, ensureBaselinePurchase } from "./baseline";
