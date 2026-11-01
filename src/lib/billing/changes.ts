import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma/raw-client";
import { AppError } from "@/lib/observability/errors";
import { lockTenantWrites } from "@/lib/tenancy/work-lifecycle";
import { readBillingPolicy } from "./policy";
import { applyProviderSnapshot } from "./provider-apply";
import { QUOTE_TTL_MS, type CheckoutDeps } from "./checkout";

/**
 * L5.2 - immediate upgrades (docs/l5.2-plan-changes-design.md): add an add-on or raise a quantity on the live
 * subscription. The server prices only the increase; the quote is bound to the subscription `rev`, so any change
 * since it was shown makes it stale. Access follows the provider's answer (`pending_if_incomplete`), never the request.
 */

const MAX_LINES = 10;
const MAX_QUANTITY = 1000;

const linesInput = z.object({
  lines: z.array(z.object({ versionId: z.string().uuid(), quantity: z.number().int().min(1).max(MAX_QUANTITY) }).strict()).min(1).max(MAX_LINES),
});
export const upgradeQuoteInput = linesInput.strict();
export const upgradeStartInput = linesInput.extend({ quoteHash: z.string().regex(/^[a-f0-9]{64}$/), quotedAt: z.string().datetime() }).strict();

export interface UpgradeLine {
  versionId: string;
  itemKey: string;
  name: string;
  /** Units added by this change. */
  quantity: number;
  /** Quantity the subscription holds afterwards. */
  targetQuantity: number;
  unitMinor: number;
  priceRef: string;
}
export interface UpgradeQuote {
  lines: UpgradeLine[];
  currency: string;
  interval: "month" | "year";
  /** Recurring increase in minor units; the provider prorates the first invoice and its figure is final. */
  totalMinor: number;
  quotedAt: string;
  expiresAt: string;
  quoteHash: string;
}

function hashQuote(businessId: string, deps: CheckoutDeps, rev: number, q: Omit<UpgradeQuote, "quoteHash" | "expiresAt">): string {
  const body = {
    kind: "upgrade",
    businessId,
    provider: deps.provider.name,
    mode: deps.mode,
    rev,
    quotedAt: q.quotedAt,
    currency: q.currency,
    interval: q.interval,
    lines: q.lines.map((l) => [l.versionId, l.targetQuantity, l.unitMinor, l.priceRef]).sort(),
  };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

async function priceUpgrade(businessId: string, lines: { versionId: string; quantity: number }[], deps: CheckoutDeps, quotedAt: Date) {
  const ids = lines.map((l) => l.versionId);
  if (new Set(ids).size !== ids.length) throw new AppError(400, "VALIDATION_ERROR", "A package can appear only once");
  const sub = await prisma.billingSubscription.findFirst({
    where: { businessId, status: { not: "ended" } },
    include: { items: { where: { state: { not: "removed" } }, include: { version: true } } },
  });
  if (!sub || sub.provider !== deps.provider.name) throw new AppError(409, "CONFLICT", "This workspace has no subscription to change");
  if (sub.status !== "active") throw new AppError(409, "CONFLICT", "Settle the current payment before changing the subscription");
  const interval = sub.items.map((i) => i.version.interval).find((x) => x === "month" || x === "year") as "month" | "year" | undefined;

  const versions = await prisma.catalogVersion.findMany({
    where: { id: { in: ids } },
    include: { item: true, priceRefs: { where: { provider: deps.provider.name, mode: deps.mode, state: "synced" } } },
  });
  const byId = new Map(versions.map((v) => [v.id, v]));
  const priced: UpgradeLine[] = [];
  for (const l of lines) {
    const v = byId.get(l.versionId);
    if (!v || v.state !== "published") throw new AppError(409, "CONFLICT", "One of the packages is no longer available. Reload and choose again");
    if (v.item.kind === "bundle") throw new AppError(400, "VALIDATION_ERROR", "The base package cannot be changed here");
    const priceRef = v.priceRefs[0]?.priceRef;
    if (!priceRef || v.priceMinor == null || !v.currency || (v.interval !== "month" && v.interval !== "year")) {
      throw new AppError(409, "CONFLICT", "This package is not ready for purchase yet");
    }
    if (v.currency !== sub.currency || (interval && v.interval !== interval)) {
      throw new AppError(400, "VALIDATION_ERROR", "Everything in one subscription must share a currency and a billing period");
    }
    const held = sub.items.find((i) => i.versionId === v.id)?.quantity ?? 0;
    if (l.quantity <= held) throw new AppError(400, "VALIDATION_ERROR", "Choose a higher quantity; reductions are scheduled separately");
    priced.push({ versionId: v.id, itemKey: v.item.key, name: v.name, quantity: l.quantity - held, targetQuantity: l.quantity, unitMinor: v.priceMinor, priceRef });
  }
  const base = {
    lines: priced,
    currency: sub.currency,
    interval: interval ?? (byId.get(ids[0])!.interval as "month" | "year"),
    totalMinor: priced.reduce((s, l) => s + l.unitMinor * l.quantity, 0),
    quotedAt: quotedAt.toISOString(),
  };
  const quote: UpgradeQuote = { ...base, expiresAt: new Date(quotedAt.getTime() + QUOTE_TTL_MS).toISOString(), quoteHash: hashQuote(businessId, deps, sub.rev, base) };
  return { quote, sub };
}

export async function quoteUpgrade(businessId: string, input: unknown, deps: CheckoutDeps, quotedAt?: Date): Promise<UpgradeQuote> {
  const parsed = upgradeQuoteInput.safeParse(input);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Choose at least one package and a whole-number quantity");
  return (await priceUpgrade(businessId, parsed.data.lines, deps, quotedAt ?? (deps.now?.() ?? new Date()))).quote;
}

export async function startUpgrade(
  actor: { businessId: string; userId: string },
  input: unknown,
  deps: CheckoutDeps,
): Promise<{ status: string; confirmed: boolean; operationId: string }> {
  const parsed = upgradeStartInput.safeParse(input);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "The change request is not valid");
  const now = deps.now?.() ?? new Date();
  const quotedAt = new Date(parsed.data.quotedAt);
  const age = now.getTime() - quotedAt.getTime();
  if (age < -60_000 || age > QUOTE_TTL_MS) throw new AppError(409, "QUOTE_EXPIRED", "This quote has expired. Review the price and try again");

  const { quote, sub } = await priceUpgrade(actor.businessId, parsed.data.lines, deps, quotedAt);
  const a = Buffer.from(quote.quoteHash);
  const b = Buffer.from(parsed.data.quoteHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(409, "QUOTE_STALE", "The subscription or price changed since you reviewed it. Review it again");
  const idemKey = createHash("sha256").update(`change|${actor.businessId}|${quote.quoteHash}`).digest("hex");

  const op = await prisma.$transaction(async (tx) => {
    await lockTenantWrites(tx, actor.businessId);
    const business = await tx.business.findUnique({ where: { id: actor.businessId }, select: { status: true } });
    if (!business || business.status !== "active") throw new AppError(403, "FORBIDDEN", "This workspace cannot change its subscription");
    const current = await tx.billingSubscription.findUnique({ where: { id: sub.id }, select: { rev: true, status: true } });
    if (!current || current.rev !== sub.rev || current.status !== "active") throw new AppError(409, "QUOTE_STALE", "The subscription changed since you reviewed it. Review it again");
    const open = await tx.billingOperation.findFirst({ where: { businessId: actor.businessId, kind: "change", state: { in: ["pending", "unknown"] } }, select: { id: true } });
    if (open) throw new AppError(409, "CONFLICT", "Another change is still being confirmed. Try again shortly");
    return tx.billingOperation.create({ data: { businessId: actor.businessId, kind: "change", idemKey, quoteHash: quote.quoteHash, requestedBy: actor.userId } });
  });

  try {
    // Item refs come from the provider's own record, never from the request.
    const remote = await deps.provider.getSubscription(sub.subscriptionRef);
    const itemRefs = new Map(remote.items.map((i) => [i.priceRef, i.itemRef]));
    const snap = await deps.provider.changeSubscription(
      { ref: sub.subscriptionRef, lines: quote.lines.map((l) => ({ priceRef: l.priceRef, quantity: l.targetQuantity, ...(itemRefs.has(l.priceRef) ? { itemRef: itemRefs.get(l.priceRef) } : {}) })) },
      idemKey,
    );
    const confirmed = quote.lines.every((l) => (snap.items.find((i) => i.priceRef === l.priceRef)?.quantity ?? 0) >= l.targetQuantity);
    const outcome = await prisma.$transaction(async (tx) => {
      await lockTenantWrites(tx, actor.businessId);
      const policy = await readBillingPolicy(tx);
      const applied = await applyProviderSnapshot(tx, snap, { businessId: actor.businessId, provider: deps.provider.name, mode: deps.mode, graceDays: policy.graceDays, now });
      if (confirmed) await tx.billingOperation.update({ where: { id: op.id }, data: { state: "succeeded" } });
      return applied;
    });
    return { status: outcome.status, confirmed, operationId: op.id };
  } catch (e) {
    await prisma.billingOperation.update({ where: { id: op.id }, data: { state: e instanceof AppError ? "failed" : "unknown" } });
    throw e;
  }
}
