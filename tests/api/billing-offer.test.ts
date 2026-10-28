import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/** L4.1b - the owner's package view: owner only, own workspace only, no financial mutation surface. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { generateToken } from "@/lib/identity/auth";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { seedBusiness, cleanupBusiness, addMember, type SeededBusiness } from "../helpers/tenant-fixtures";

let a: SeededBusiness;
let b: SeededBusiness;
const tokens: Record<string, string> = {};
beforeAll(async () => {
  a = await seedBusiness("offer-a");
  b = await seedBusiness("offer-b");
  tokens.owner = generateToken(a.ownerUserId);
  for (const role of ["admin", "supervisor", "agent", "viewer"] as const) tokens[role] = generateToken((await addMember(a.businessId, role, `offer-${role}`)).userId);
});
afterAll(async () => {
  await cleanupBusiness(a.businessId);
  await cleanupBusiness(b.businessId);
});
const get = async (token: string) => (await import("@/app/api/billing/offer/route")).GET(createRequest("/api/billing/offer", { cookies: { "owly-token": token } }));

describe("GET /api/billing/offer", () => {
  it("shows the owner their baseline package, capabilities with sources, and seat use", async () => {
    const res = await get(tokens.owner);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await parseJsonResponse(res);
    expect(body.purchases.map((p: { itemKey: string }) => p.itemKey)).toEqual(["legacy-baseline"]);
    expect(body.capabilities.find((c: { key: string }) => c.key === "data.export")).toMatchObject({ granted: true, sources: ["purchase"] });
    expect(body.seats.members).toBeGreaterThanOrEqual(5);
    expect(body.seats.limit).toBe(1000);
  });
  it("is refused to every other role, and anonymous callers", async () => {
    for (const role of ["admin", "supervisor", "agent", "viewer"]) expect([401, 403], role).toContain((await get(tokens[role])).status);
    const { GET } = await import("@/app/api/billing/offer/route");
    expect((await GET(createRequest("/api/billing/offer"))).status).toBe(401);
  });
  it("describes only the caller's own workspace", async () => {
    const body = await parseJsonResponse(await get(tokens.owner));
    expect(JSON.stringify(body)).not.toContain(b.businessId);
  });
});
