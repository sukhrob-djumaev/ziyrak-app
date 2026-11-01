import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma/raw-client";
import { AppError } from "@/lib/observability/errors";
import { lockTenantWrites } from "@/lib/tenancy/work-lifecycle";
import { readBillingPolicy } from "./policy";
import { applyProviderSnapshot } from "./provider-apply";
import { entitledLimit } from "./entitlements";
import { seatsInUse, suspendUnchosen } from "./member-seats";
import { QUOTE_TTL_MS, type CheckoutDeps } from "./checkout";
import { ProviderError } from "./providers/types";

/**
 * L5.2 - immediate upgrades (docs/l5.2-plan-changes-design.md): add an add-on or raise a quantity on the live
 * subscription. The server prices only the increase; the quote is bound to the subscription `rev`, so any change
 * since it was shown makes it stale. Access follows the provider's answer (`pending_if_incomplete`), never the request.
 */

/** A change still unsettled after this long no longer blocks the next one; the provider's idempotency key makes a late replay safe. */
const OPEN_OP_MS = 30 * 60 * 1000;
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
    const open = await tx.billingOperation.findFirst({
      where: { businessId: actor.businessId, kind: "change", state: { in: ["pending", "unknown"] }, createdAt: { gt: new Date(now.getTime() - OPEN_OP_MS) } },
      select: { id: true },
    });
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
    await prisma.billingOperation.update({ where: { id: op.id }, data: { state: e instanceof AppError || (e instanceof ProviderError && e.kind === "rejected") ? "failed" : "unknown" } });
    throw e;
  }
}

const reductionInput = z
  .object({ lines: z.array(z.object({ versionId: z.string().uuid(), quantity: z.number().int().min(0).max(MAX_QUANTITY) }).strict()).min(1).max(MAX_LINES) })
  .strict();

const seatAmount = (grants: unknown): number =>
  Array.isArray(grants) ? grants.reduce((n: number, g) => ((g as { capability?: string })?.capability === "seats.members" ? n + ((g as { amount?: number }).amount ?? 1) : n), 0) : 0;
const grantsSeats = (grants: unknown) => seatAmount(grants) > 0;

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Members and open invitations that hold a seat today, and the limit once every scheduled seat decrease of the workspace applies. */
async function seatUsage(tx: Tx, businessId: string) {
  const [[members, invited], limit, pending] = await Promise.all([
    seatsInUse(tx, businessId),
    entitledLimit(businessId, "seats.members", tx),
    tx.billingSubscriptionItem.findMany({ where: { state: "scheduled_remove", subscription: { businessId } }, include: { version: true } }),
  ]);
  const drop = pending.reduce((n, p) => n + (p.quantity - (p.pendingQuantity ?? p.quantity)) * seatAmount(p.version.grants), 0);
  return { members, openInvitations: invited, newLimit: limit - drop };
}

/** The owner's recorded choice: who stays and when it was made. */
const readChoice = (raw: unknown): { ids: string[]; at: Date } | null => {
  const c = raw as { ids?: unknown; at?: unknown } | null;
  if (!c || !Array.isArray(c.ids) || typeof c.at !== "string" || Number.isNaN(Date.parse(c.at))) return null;
  return { ids: c.ids as string[], at: new Date(c.at) };
};

/**
 * The set of members that fits the new limit and keeps every owner; null when it does not. A choice is stale, and so lapses,
 * when someone joined after it was made: nobody is suspended without the owner having seen them.
 */
async function validStayers(tx: Tx, businessId: string, choice: { ids: unknown; at?: Date }, newLimit: number, invited: number): Promise<string[] | null> {
  const ids = choice.ids;
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string") || new Set(ids).size !== ids.length) return null;
  const rows = await tx.membership.findMany({ where: { businessId, suspendedByPlanAt: null }, select: { id: true, role: true, createdAt: true } });
  const live = new Set(rows.map((r) => r.id));
  if (!ids.every((x: string) => live.has(x))) return null;
  if (!rows.filter((r) => r.role === "owner").every((r) => ids.includes(r.id))) return null;
  if (choice.at && rows.some((r) => !ids.includes(r.id) && r.createdAt > choice.at!)) return null;
  return ids.length + invited <= newLimit ? (ids as string[]) : null;
}

/** Schedules removals and decreases for the end of the paid period. Nothing is taken away before then and the provider is not called. */
export async function scheduleReduction(actor: { businessId: string; userId: string }, input: unknown, deps: CheckoutDeps): Promise<{ effectiveAt: string }> {
  const parsed = reductionInput.safeParse(input);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Choose what to reduce");
  const ids = parsed.data.lines.map((l) => l.versionId);
  if (new Set(ids).size !== ids.length) throw new AppError(400, "VALIDATION_ERROR", "A package can appear only once");
  return prisma.$transaction(async (tx) => {
    await lockTenantWrites(tx, actor.businessId);
    const business = await tx.business.findUnique({ where: { id: actor.businessId }, select: { status: true } });
    if (!business || business.status !== "active") throw new AppError(403, "FORBIDDEN", "This workspace cannot change its subscription");
    const sub = await tx.billingSubscription.findFirst({
      where: { businessId: actor.businessId, status: "active", provider: deps.provider.name },
      include: { items: { where: { state: { not: "removed" } }, include: { version: { include: { item: true } } } } },
    });
    if (!sub) throw new AppError(409, "CONFLICT", "This workspace has no active subscription to change");
    for (const l of parsed.data.lines) {
      const it = sub.items.find((i) => i.versionId === l.versionId);
      if (!it || it.version.item.kind === "bundle" || l.quantity >= it.quantity) throw new AppError(400, "VALIDATION_ERROR", "That reduction is not possible");
      await tx.billingSubscriptionItem.update({ where: { id: it.id }, data: { state: "scheduled_remove", pendingQuantity: l.quantity, pendingStayers: Prisma.DbNull, effectiveAt: sub.currentPeriodEnd ?? new Date() } });
    }
    await tx.billingSubscription.update({ where: { id: sub.id }, data: { rev: { increment: 1 } } });
    return { effectiveAt: (sub.currentPeriodEnd ?? new Date()).toISOString() };
  });
}

/** Withdraws a scheduled reduction; the item keeps its current quantity. */
export async function cancelReduction(actor: { businessId: string; userId: string }, input: { versionId: string }): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockTenantWrites(tx, actor.businessId);
    const it = await tx.billingSubscriptionItem.findFirst({ where: { versionId: input.versionId, state: "scheduled_remove", subscription: { businessId: actor.businessId } } });
    if (!it) throw new AppError(404, "NOT_FOUND", "Nothing is scheduled for this package");
    await tx.billingSubscriptionItem.update({ where: { id: it.id }, data: { state: "active", pendingQuantity: null, pendingStayers: Prisma.DbNull } });
    await tx.billingSubscription.update({ where: { id: it.subscriptionId }, data: { rev: { increment: 1 } } });
  });
}

/** What the owner sees for a scheduled seat decrease: usage against the new limit and who they have kept so far. */
export async function seatConflict(businessId: string, versionId: string) {
  return prisma.$transaction(async (tx) => {
    const it = await tx.billingSubscriptionItem.findFirst({
      where: { versionId, state: "scheduled_remove", subscription: { businessId } },
      include: { version: true },
    });
    if (!it || !grantsSeats(it.version.grants)) throw new AppError(404, "NOT_FOUND", "No team-size reduction is scheduled");
    const u = await seatUsage(tx, businessId);
    return { ...u, effectiveAt: it.effectiveAt.toISOString(), chosen: readChoice(it.pendingStayers)?.ids ?? null };
  });
}

/** Records who keeps a seat when the scheduled decrease applies. Nobody is suspended until then, and never without a valid choice. */
export async function chooseStayers(actor: { businessId: string; userId: string }, input: { versionId: string; membershipIds: string[] }): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockTenantWrites(tx, actor.businessId);
    const it = await tx.billingSubscriptionItem.findFirst({
      where: { versionId: input.versionId, state: "scheduled_remove", subscription: { businessId: actor.businessId } },
      include: { version: true },
    });
    if (!it || !grantsSeats(it.version.grants)) throw new AppError(404, "NOT_FOUND", "No team-size reduction is scheduled");
    const u = await seatUsage(tx, actor.businessId);
    const ids = input.membershipIds;
    const ok = await validStayers(tx, actor.businessId, { ids }, Number.MAX_SAFE_INTEGER, 0);
    if (!ok) throw new AppError(400, "VALIDATION_ERROR", "Choose current members of this workspace, and keep every owner");
    if (ids.length + u.openInvitations > u.newLimit) throw new AppError(409, "CONFLICT", `The new limit is ${u.newLimit} seats. Choose fewer people or revoke open invitations`);
    await tx.billingSubscriptionItem.update({ where: { id: it.id }, data: { pendingStayers: { ids, at: new Date().toISOString() } } });
  });
}

/**
 * Control-plane job body: sends every reduction that has reached its effective time to the provider, one subscription at a time.
 * A seat decrease that leaves more people than seats needs the owner's valid choice; without one it lapses (the old quantity keeps
 * billing and nobody loses access by inaction), and with one the unchosen members are suspended in the same transaction.
 */
export async function applyDueReductions(deps: CheckoutDeps, now: Date = new Date()): Promise<number> {
  const due = await prisma.billingSubscriptionItem.findMany({
    where: { state: "scheduled_remove", effectiveAt: { lte: now }, subscription: { status: "active", provider: deps.provider.name } },
    include: { subscription: true, version: true },
  });
  const bySub = new Map<string, typeof due>();
  for (const it of due) bySub.set(it.subscriptionId, [...(bySub.get(it.subscriptionId) ?? []), it]);
  let applied = 0;
  for (const all of bySub.values()) {
    const sub = all[0].subscription;
    const stayers = new Map<string, string[]>();
    const items: typeof all = [];
    for (const it of all) {
      if (!grantsSeats(it.version.grants)) {
        items.push(it);
        continue;
      }
      const verdict = await prisma.$transaction(async (tx) => {
        await lockTenantWrites(tx, sub.businessId);
        const u = await seatUsage(tx, sub.businessId);
        if (u.members + u.openInvitations <= u.newLimit) return "fits" as const;
        const chosen = await validStayers(tx, sub.businessId, readChoice(it.pendingStayers) ?? { ids: null }, u.newLimit, u.openInvitations);
        if (chosen) return chosen;
        await tx.billingSubscriptionItem.update({ where: { id: it.id }, data: { state: "active", pendingQuantity: null, pendingStayers: Prisma.DbNull } });
        await tx.billingSubscription.update({ where: { id: sub.id }, data: { rev: { increment: 1 } } });
        return "lapsed" as const;
      });
      if (verdict === "lapsed") continue;
      if (verdict !== "fits") stayers.set(it.id, verdict);
      items.push(it);
    }
    if (items.length === 0) continue;
    const remote = await deps.provider.getSubscription(sub.subscriptionRef);
    const refs = await prisma.providerPriceRef.findMany({ where: { provider: deps.provider.name, mode: deps.mode, versionId: { in: items.map((i) => i.versionId) } } });
    const lines = items.flatMap((it) => {
      const priceRef = refs.find((r) => r.versionId === it.versionId)?.priceRef;
      const itemRef = remote.items.find((r) => r.priceRef === priceRef)?.itemRef;
      if (!priceRef || !itemRef) return [];
      return [{ priceRef, quantity: it.pendingQuantity ?? 0, itemRef, ...(!it.pendingQuantity ? { remove: true } : {}) }];
    });
    if (lines.length === 0) continue;
    const idemKey = createHash("sha256").update(`reduce|${sub.id}|${items.map((i) => `${i.id}:${i.pendingQuantity}`).sort().join(",")}`).digest("hex");
    const snap = await deps.provider.changeSubscription({ ref: sub.subscriptionRef, lines }, idemKey);
    await prisma.$transaction(async (tx) => {
      await lockTenantWrites(tx, sub.businessId);
      const policy = await readBillingPolicy(tx);
      await applyProviderSnapshot(tx, snap, { businessId: sub.businessId, provider: deps.provider.name, mode: deps.mode, graceDays: policy.graceDays, now });
      for (const keep of stayers.values()) {
        await suspendUnchosen(tx, sub.businessId, keep, now);
      }
    });
    applied += lines.length;
  }
  return applied;
}
