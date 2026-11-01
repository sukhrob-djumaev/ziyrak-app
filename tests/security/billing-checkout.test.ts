import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/** L5.1 - owner checkout: server-priced cart, quote binding, one live subscription, server-chosen return URLs. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { quoteCheckout, startCheckout, QUOTE_TTL_MS } from "@/lib/billing/checkout";
import type { PaymentProvider } from "@/lib/billing/providers/types";

const tag = `bc-${Date.now()}`;
let biz: string, other: string, user: string;
const ids = { bundle: "", addon: "", usd: "" };
const createCheckout = vi.fn(async (i: { successUrl: string; cancelUrl: string }) => ({ url: `https://pay.example/${tag}`, sessionRef: `${tag}-cs`, ...i }));
const createCustomer = vi.fn(async () => ({ customerRef: `${tag}-cus` }));
const provider = { name: "stripe", createCheckout, createCustomer } as unknown as PaymentProvider;
const env = { NEXT_PUBLIC_APP_URL: "https://app.example.test/dashboard?x=1" } as NodeJS.ProcessEnv;
const deps = { provider, mode: "test" as const, env };
const fresh = async (lines: { versionId: string; quantity: number }[]) => {
  const q = await quoteCheckout(biz, { lines }, deps);
  return { lines, quoteHash: q.quoteHash, quotedAt: q.quotedAt };
};

async function version(key: string, kind: string, over: Record<string, unknown> = {}, synced = true) {
  const item = await prisma.catalogItem.create({ data: { key: `${tag}-${key}`, kind } });
  const v = await prisma.catalogVersion.create({
    data: { itemId: item.id, version: 1, state: "published", name: key, grants: [{ capability: "channel.webchat" }], priceMinor: 19900, currency: "MYR", interval: "month", publishedAt: new Date(), ...over },
  });
  if (synced) await prisma.providerPriceRef.create({ data: { versionId: v.id, provider: "stripe", mode: "test", priceRef: `${tag}-${key}-price`, state: "synced" } });
  return v.id;
}

beforeAll(async () => {
  biz = (await prisma.business.create({ data: { name: tag, slug: tag } })).id;
  other = (await prisma.business.create({ data: { name: `${tag}-o`, slug: `${tag}-o` } })).id;
  user = (await prisma.user.create({ data: { email: `${tag}@example.test`, password: "x", username: tag } })).id;
  ids.bundle = await version("bundle", "bundle");
  ids.addon = await version("addon", "addon", { priceMinor: 5000 });
  ids.usd = await version("usd", "addon", { currency: "USD" });
});
afterAll(async () => {
  await prisma.billingSubscription.deleteMany({ where: { businessId: { in: [biz, other] } } });
  await prisma.billingOperation.deleteMany({ where: { businessId: { in: [biz, other] } } });
  await prisma.billingCustomer.deleteMany({ where: { businessId: { in: [biz, other] } } });
  await prisma.providerPriceRef.deleteMany({ where: { versionId: { in: Object.values(ids) } } });
  await prisma.business.deleteMany({ where: { id: { in: [biz, other] } } });
  if (user) await prisma.user.deleteMany({ where: { id: user } });
});

describe("checkout quote", () => {
  it("prices the cart on the server from synced versions", async () => {
    const q = await quoteCheckout(biz, { lines: [{ versionId: ids.bundle, quantity: 1 }, { versionId: ids.addon, quantity: 3 }] }, deps);
    expect(q.totalMinor).toBe(19900 + 3 * 5000);
    expect(q.currency).toBe("MYR");
    expect(q.interval).toBe("month");
    expect(Date.parse(q.expiresAt) - Date.parse(q.quotedAt)).toBe(QUOTE_TTL_MS);
  });

  it("refuses unsold, unsynced, mixed-currency and malformed carts", async () => {
    const unsynced = await version("nosync", "addon", {}, false);
    const q = (lines: unknown[]) => quoteCheckout(biz, { lines }, deps);
    await expect(q([{ versionId: unsynced, quantity: 1 }])).rejects.toMatchObject({ statusCode: 409 });
    await expect(q([{ versionId: ids.bundle, quantity: 1 }, { versionId: ids.usd, quantity: 1 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(q([{ versionId: ids.bundle, quantity: 2 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(q([{ versionId: ids.addon, quantity: 0 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(q([{ versionId: ids.addon, quantity: 1 }, { versionId: ids.addon, quantity: 1 }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(q([{ versionId: "00000000-0000-4000-8000-000000000000", quantity: 1 }])).rejects.toMatchObject({ statusCode: 409 });
    await expect(q([])).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("start checkout", () => {
  it("creates one operation and a hosted session with server-chosen return URLs; a retry resumes it", async () => {
    const body = await fresh([{ versionId: ids.bundle, quantity: 1 }]);
    const a = await startCheckout({ businessId: biz, userId: user }, { ...body, successUrl: "https://evil.example" }, deps).catch((e) => e);
    expect(a).toMatchObject({ statusCode: 400 });
    const r1 = await startCheckout({ businessId: biz, userId: user }, body, deps);
    const r2 = await startCheckout({ businessId: biz, userId: user }, body, deps);
    expect(r2.operationId).toBe(r1.operationId);
    expect(r1.url).toBe(`https://pay.example/${tag}`);
    const call = createCheckout.mock.calls[0][0] as unknown as { successUrl: string; cancelUrl: string; businessId: string; operationId: string; lines: unknown[] };
    expect(call.successUrl).toBe("https://app.example.test/billing?checkout=return");
    expect(call.cancelUrl).toBe("https://app.example.test/billing?checkout=cancelled");
    expect(call.businessId).toBe(biz);
    expect(call.lines).toEqual([{ priceRef: `${tag}-bundle-price`, quantity: 1 }]);
    expect(createCustomer).toHaveBeenCalledTimes(1);
    expect(await prisma.billingOperation.count({ where: { businessId: biz } })).toBe(1);
    expect((await prisma.billingOperation.findUniqueOrThrow({ where: { id: r1.operationId } })).sessionRef).toBe(`${tag}-cs`);
  });

  it("rejects a tampered, expired or foreign quote", async () => {
    const body = await fresh([{ versionId: ids.addon, quantity: 2 }]);
    await expect(startCheckout({ businessId: biz, userId: user }, { ...body, lines: [{ versionId: ids.addon, quantity: 3 }] }, deps)).rejects.toMatchObject({ code: "QUOTE_STALE" });
    await expect(startCheckout({ businessId: other, userId: user }, body, deps)).rejects.toMatchObject({ code: "QUOTE_STALE" });
    const late = { ...deps, now: () => new Date(Date.parse(body.quotedAt) + QUOTE_TTL_MS + 1000) };
    await expect(startCheckout({ businessId: biz, userId: user }, body, late)).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
  });

  it("refuses a suspended workspace and a second live subscription", async () => {
    const body = await fresh([{ versionId: ids.addon, quantity: 1 }]);
    await prisma.business.update({ where: { id: biz }, data: { status: "suspended" } });
    await expect(startCheckout({ businessId: biz, userId: user }, body, deps)).rejects.toMatchObject({ statusCode: 403 });
    await prisma.business.update({ where: { id: biz }, data: { status: "active" } });
    await prisma.billingSubscription.create({ data: { businessId: biz, provider: "stripe", subscriptionRef: `${tag}-sub`, customerRef: `${tag}-cus`, status: "active", currency: "MYR" } });
    await expect(startCheckout({ businessId: biz, userId: user }, body, deps)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("fails closed without a configured origin", async () => {
    const lines = [{ versionId: ids.addon, quantity: 1 }];
    const q = await quoteCheckout(other, { lines }, deps);
    const body = { lines, quoteHash: q.quoteHash, quotedAt: q.quotedAt };
    await expect(startCheckout({ businessId: other, userId: user }, body, { ...deps, env: {} as NodeJS.ProcessEnv })).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe("customer portal", () => {
  it("opens the portal for the workspace's own customer with an env-origin return URL", async () => {
    const { openPortal } = await import("@/lib/billing/checkout");
    const createPortal = vi.fn(async () => ({ url: "https://portal.example/x" }));
    const p = { name: "stripe", createPortal } as unknown as PaymentProvider;
    await expect(openPortal(other, p, env)).rejects.toMatchObject({ statusCode: 404 });
    await prisma.billingCustomer.create({ data: { businessId: other, provider: "stripe", customerRef: `${tag}-ocus` } });
    expect(await openPortal(other, p, env)).toEqual({ url: "https://portal.example/x" });
    expect(createPortal).toHaveBeenCalledWith({ customerRef: `${tag}-ocus`, returnUrl: "https://app.example.test/billing" });
  });
});
