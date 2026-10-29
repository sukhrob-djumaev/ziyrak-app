import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * GET /api/me — who is signed in and for which business, so the dashboard header
 * can show a real name and business instead of a hard-coded initial.
 * Real Postgres + real auth.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { generateToken } from "@/lib/identity/auth";
import { prisma } from "@/lib/prisma/raw-client";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { seedBusiness, cleanupBusiness, addMember, type SeededBusiness } from "../helpers/tenant-fixtures";

let a: SeededBusiness;
let b: SeededBusiness;
let ownerToken: string;
let agentToken: string;

beforeAll(async () => {
  a = await seedBusiness("me-a");
  b = await seedBusiness("me-b");
  ownerToken = generateToken(a.ownerUserId);
  agentToken = generateToken((await addMember(a.businessId, "agent", "me-agent")).userId);
  await prisma.user.update({ where: { id: a.ownerUserId }, data: { name: "Olivia Owner" } });
  await prisma.businessConfig.upsert({
    where: { businessId: a.businessId },
    update: { businessName: "Acme Support" },
    create: { businessId: a.businessId, businessName: "Acme Support" },
  });
});

afterAll(async () => {
  await cleanupBusiness(a.businessId);
  await cleanupBusiness(b.businessId);
});

const get = async (token?: string, headers: Record<string, string> = {}) => {
  const { GET } = await import("@/app/api/me/route");
  return GET(createRequest("/api/me", { cookies: token ? { "ziyrak-token": token } : {}, headers }));
};

describe("GET /api/me", () => {
  it("returns the signed-in user, their role and their business's name", async () => {
    const response = await get(ownerToken);
    expect(response.status).toBe(200);
    expect(await parseJsonResponse(response)).toEqual({
      user: { id: a.ownerUserId, name: "Olivia Owner", username: a.ownerUsername },
      role: "owner",
      business: { id: a.businessId, name: "Acme Support" },
    });
  });

  it("reports the member's own role in the same business", async () => {
    const body = await parseJsonResponse(await get(agentToken));
    expect(body.role).toBe("agent");
    expect(body.business).toEqual({ id: a.businessId, name: "Acme Support" });
  });

  it("never returns another business's details or any secret", async () => {
    const body = await parseJsonResponse(await get(generateToken(b.ownerUserId)));
    expect(body.business.id).toBe(b.businessId);
    expect(body.business.name).not.toBe("Acme Support");
    expect(JSON.stringify(body)).not.toMatch(/password|hash|token/i);
  });

  it("requires a signed-in user", async () => {
    expect((await get()).status).toBe(401);
  });

  it("has no user for an API-key caller (there is no person behind a key)", async () => {
    const response = await get(undefined, { "x-api-key": "zy_not_a_real_key_00000000" });
    expect(response.status).toBe(401); // an invalid key is simply unauthenticated
  });
});
