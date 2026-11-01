import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/** L5.1 - quote and checkout endpoints: owner only, provider required, the body cannot choose URLs. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

const h = vi.hoisted(() => ({ provider: null as unknown }));
vi.mock("@/lib/billing/providers", async (importOriginal) => ({ ...(await importOriginal<object>()), getPaymentProvider: () => h.provider }));

import { prisma } from "@/lib/prisma/raw-client";
import { generateToken } from "@/lib/identity/auth";
import { createRequest } from "../helpers/request";
import { seedBusiness, cleanupBusiness, addMember, type SeededBusiness } from "../helpers/tenant-fixtures";

let a: SeededBusiness;
const tokens: Record<string, string> = {};
let versionId: string;
const tag = `bcr-${Date.now()}`;
const post = async (path: "quote" | "checkout", token: string | null, body: unknown) => {
  const route = path === "quote" ? await import("@/app/api/billing/quote/route") : await import("@/app/api/billing/checkout/route");
  return route.POST(createRequest(`/api/billing/${path}`, { method: "POST", body, ...(token ? { cookies: { "ziyrak-token": token } } : {}) }));
};

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
  a = await seedBusiness("bcr-a");
  tokens.owner = generateToken(a.ownerUserId);
  for (const role of ["admin", "supervisor", "agent", "viewer"] as const) tokens[role] = generateToken((await addMember(a.businessId, role, `bcr-${role}`)).userId);
  const item = await prisma.catalogItem.create({ data: { key: tag, kind: "addon" } });
  versionId = (await prisma.catalogVersion.create({ data: { itemId: item.id, version: 1, state: "published", name: tag, grants: [{ capability: "channel.webchat" }], priceMinor: 5000, currency: "MYR", interval: "month", publishedAt: new Date() } })).id;
  await prisma.providerPriceRef.create({ data: { versionId, provider: "stripe", mode: "test", priceRef: `${tag}-price`, state: "synced" } });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.billingOperation.deleteMany({ where: { businessId: a.businessId } });
  await prisma.billingCustomer.deleteMany({ where: { businessId: a.businessId } });
  await prisma.providerPriceRef.deleteMany({ where: { versionId } });
  await cleanupBusiness(a.businessId);
});

const lines = () => ({ lines: [{ versionId, quantity: 1 }] });

describe("billing quote and checkout endpoints", () => {
  it("are unavailable without a configured provider", async () => {
    h.provider = null;
    expect((await post("quote", tokens.owner, lines())).status).toBe(404);
    expect((await post("checkout", tokens.owner, lines())).status).toBe(404);
  });

  it("refuse every non-owner role and anonymous callers", async () => {
    h.provider = { name: "stripe" };
    for (const path of ["quote", "checkout"] as const) {
      for (const role of ["admin", "supervisor", "agent", "viewer"]) expect([401, 403], `${path} ${role}`).toContain((await post(path, tokens[role], lines())).status);
      expect((await post(path, null, lines())).status).toBe(401);
    }
  });

  it("lets the owner price a cart, then start checkout only with that quote", async () => {
    const createCheckout = vi.fn(async () => ({ url: "https://pay.example/x", sessionRef: `${tag}-cs` }));
    h.provider = { name: "stripe", createCheckout, createCustomer: async () => ({ customerRef: `${tag}-cus` }) };
    const q = await post("quote", tokens.owner, lines());
    expect(q.status).toBe(200);
    const quote = await q.json();
    expect(quote.totalMinor).toBe(5000);
    expect((await post("checkout", tokens.owner, { ...lines(), quoteHash: "0".repeat(64), quotedAt: quote.quotedAt })).status).toBe(409);
    const ok = await post("checkout", tokens.owner, { ...lines(), quoteHash: quote.quoteHash, quotedAt: quote.quotedAt });
    expect(ok.status).toBe(200);
    expect((await ok.json()).url).toBe("https://pay.example/x");
    expect((await post("checkout", tokens.owner, { ...lines(), quoteHash: quote.quoteHash, quotedAt: quote.quotedAt, successUrl: "https://evil.example" })).status).toBe(400);
  });
});
