import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma/raw-client";
import { AppError } from "@/lib/observability/errors";
import { lockTenantWrites } from "@/lib/tenancy/work-lifecycle";
import type { PaymentProvider } from "./providers/types";
import type { BillingMode } from "./providers";

/**
 * L5.1 - owner checkout (docs/l5-payment-lifecycle-design.md section 5). The server recomputes every line from
 * published, provider-synced versions; the client sends only version ids, quantities and the quote it was shown.
 * Return URLs come from the configured app origin, never from the request. Starting a checkout grants nothing: access
 * follows the confirmed subscription (provider-events).
 */

export const QUOTE_TTL_MS = 15 * 60 * 1000;
const MAX_LINES = 10;
const MAX_QUANTITY = 1000;

const linesInput = z.object({
  lines: z
    .array(z.object({ versionId: z.string().uuid(), quantity: z.number().int().min(1).max(MAX_QUANTITY) }).strict())
    .min(1)
    .max(MAX_LINES),
});
export const quoteInput = linesInput.strict();
export const checkoutInput = linesInput.extend({ quoteHash: z.string().regex(/^[a-f0-9]{64}$/), quotedAt: z.string().datetime() }).strict();

export interface QuoteLine {
  versionId: string;
  itemKey: string;
  kind: string;
  name: string;
  quantity: number;
  unitMinor: number;
  priceRef: string;
}
export interface Quote {
  lines: QuoteLine[];
  currency: string;
  interval: "month" | "year";
  /** Recurring total in minor units. An estimate of the first invoice; the provider's figure is final. */
  totalMinor: number;
  quotedAt: string;
  expiresAt: string;
  quoteHash: string;
}

export interface CheckoutDeps {
  provider: PaymentProvider;
  mode: BillingMode;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

function hashQuote(businessId: string, provider: string, mode: string, q: Omit<Quote, "quoteHash" | "expiresAt">): string {
  const body = {
    businessId,
    provider,
    mode,
    quotedAt: q.quotedAt,
    currency: q.currency,
    interval: q.interval,
    lines: q.lines.map((l) => [l.versionId, l.quantity, l.unitMinor, l.priceRef]).sort(),
  };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** Prices the requested cart. Pure of side effects; throws a user-facing 400/409 for any cart that cannot be sold. */
export async function quoteCheckout(businessId: string, input: unknown, deps: CheckoutDeps, quotedAt?: Date): Promise<Quote> {
  const parsed = quoteInput.safeParse(input);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Choose at least one package and a whole-number quantity");
  return priceCart(businessId, parsed.data.lines, deps, quotedAt ?? (deps.now?.() ?? new Date()));
}

async function priceCart(businessId: string, lines: { versionId: string; quantity: number }[], deps: CheckoutDeps, quotedAt: Date): Promise<Quote> {
  const ids = lines.map((l) => l.versionId);
  if (new Set(ids).size !== ids.length) throw new AppError(400, "VALIDATION_ERROR", "A package can appear only once");
  const versions = await prisma.catalogVersion.findMany({
    where: { id: { in: ids } },
    include: { item: true, priceRefs: { where: { provider: deps.provider.name, mode: deps.mode, state: "synced" } } },
  });
  const byId = new Map(versions.map((v) => [v.id, v]));
  const priced: QuoteLine[] = [];
  for (const l of lines) {
    const v = byId.get(l.versionId);
    if (!v || v.state !== "published") throw new AppError(409, "CONFLICT", "One of the packages is no longer available. Reload and choose again");
    const priceRef = v.priceRefs[0]?.priceRef;
    if (!priceRef || v.priceMinor == null || !v.currency || (v.interval !== "month" && v.interval !== "year")) {
      throw new AppError(409, "CONFLICT", "This package is not ready for purchase yet");
    }
    priced.push({ versionId: v.id, itemKey: v.item.key, kind: v.item.kind, name: v.name, quantity: l.quantity, unitMinor: v.priceMinor, priceRef });
  }
  const all = versions.filter((v) => byId.has(v.id));
  if (new Set(all.map((v) => v.currency)).size !== 1 || new Set(all.map((v) => v.interval)).size !== 1) {
    throw new AppError(400, "VALIDATION_ERROR", "Everything in one subscription must share a currency and a billing period");
  }
  if (priced.filter((l) => l.kind === "bundle").length > 1) throw new AppError(400, "VALIDATION_ERROR", "Choose only one base package");
  if (priced.some((l) => l.kind === "bundle" && l.quantity !== 1)) throw new AppError(400, "VALIDATION_ERROR", "A base package is bought once");
  const base = { lines: priced, currency: all[0].currency!, interval: all[0].interval as "month" | "year", totalMinor: priced.reduce((s, l) => s + l.unitMinor * l.quantity, 0), quotedAt: quotedAt.toISOString() };
  return { ...base, expiresAt: new Date(quotedAt.getTime() + QUOTE_TTL_MS).toISOString(), quoteHash: hashQuote(businessId, deps.provider.name, deps.mode, base) };
}

/** Origin that return URLs are built on: the configured app origin only. */
export function billingReturnOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.NEXT_PUBLIC_APP_URL;
  try {
    const u = new URL(raw ?? "");
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
    return u.origin;
  } catch {
    throw new AppError(503, "BILLING_UNAVAILABLE", "Billing is not configured for this deployment");
  }
}

export async function startCheckout(
  actor: { businessId: string; userId: string },
  input: unknown,
  deps: CheckoutDeps,
): Promise<{ url: string; operationId: string }> {
  const parsed = checkoutInput.safeParse(input);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "The checkout request is not valid");
  const now = deps.now?.() ?? new Date();
  const quotedAt = new Date(parsed.data.quotedAt);
  const age = now.getTime() - quotedAt.getTime();
  if (age < -60_000 || age > QUOTE_TTL_MS) throw new AppError(409, "QUOTE_EXPIRED", "This quote has expired. Review the price and try again");

  const quote = await priceCart(actor.businessId, parsed.data.lines, deps, quotedAt);
  const a = Buffer.from(quote.quoteHash);
  const b = Buffer.from(parsed.data.quoteHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(409, "QUOTE_STALE", "The price changed since you reviewed it. Review it again");

  const origin = billingReturnOrigin(deps.env ?? process.env);
  const idemKey = createHash("sha256").update(`checkout|${actor.businessId}|${quote.quoteHash}`).digest("hex");

  const op = await prisma.$transaction(async (tx) => {
    await lockTenantWrites(tx, actor.businessId);
    const business = await tx.business.findUnique({ where: { id: actor.businessId }, select: { status: true } });
    if (!business || business.status !== "active") throw new AppError(403, "FORBIDDEN", "This workspace cannot start a subscription");
    const live = await tx.billingSubscription.findFirst({ where: { businessId: actor.businessId, status: { not: "ended" } }, select: { id: true } });
    if (live) throw new AppError(409, "CONFLICT", "This workspace already has a subscription. Change it instead");
    const existing = await tx.billingOperation.findUnique({ where: { idemKey } });
    if (existing) {
      if (existing.businessId !== actor.businessId) throw new AppError(409, "CONFLICT", "This checkout cannot be resumed");
      return existing;
    }
    return tx.billingOperation.create({ data: { businessId: actor.businessId, kind: "checkout", idemKey, quoteHash: quote.quoteHash, requestedBy: actor.userId } });
  });

  const customerRef = await ensureCustomer(actor, deps.provider);
  const session = await deps.provider.createCheckout(
    {
      businessId: actor.businessId,
      operationId: op.id,
      customerRef,
      lines: quote.lines.map((l) => ({ priceRef: l.priceRef, quantity: l.quantity })),
      successUrl: `${origin}/billing?checkout=return`,
      cancelUrl: `${origin}/billing?checkout=cancelled`,
    },
    idemKey,
  );
  if (op.sessionRef !== session.sessionRef) await prisma.billingOperation.update({ where: { id: op.id }, data: { sessionRef: session.sessionRef } });
  return { url: session.url, operationId: op.id };
}

/** Provider portal link for the workspace's own customer record; the return URL comes from the env origin. */
export async function openPortal(businessId: string, provider: PaymentProvider, env: NodeJS.ProcessEnv = process.env): Promise<{ url: string }> {
  const customer = await prisma.billingCustomer.findUnique({ where: { businessId } });
  if (!customer) throw new AppError(404, "NOT_FOUND", "There is no subscription to manage yet");
  return provider.createPortal({ customerRef: customer.customerRef, returnUrl: `${billingReturnOrigin(env)}/billing` });
}

async function ensureCustomer(actor: { businessId: string; userId: string }, provider: PaymentProvider): Promise<string> {
  const found = await prisma.billingCustomer.findUnique({ where: { businessId: actor.businessId } });
  if (found) return found.customerRef;
  const user = await prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true } });
  const { customerRef } = await provider.createCustomer({ businessId: actor.businessId, email: user?.email ?? undefined }, `customer-${actor.businessId}`);
  try {
    await prisma.billingCustomer.create({ data: { businessId: actor.businessId, provider: provider.name, customerRef } });
    return customerRef;
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
    const again = await prisma.billingCustomer.findUnique({ where: { businessId: actor.businessId } });
    if (!again) throw e;
    return again.customerRef;
  }
}
