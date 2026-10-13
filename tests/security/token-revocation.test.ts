import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";

/**
 * Sign-out must end the session. Before this, `logout` only cleared the
 * cookie: a copied token stayed valid for its whole 7-day life (found in the
 * 2026-09-21 acceptance pass). Each token now carries a `jti`; logout records
 * it in `RevokedToken`, and every place that turns a cookie into an identity
 * (API routes, server components, the page gate in the proxy) refuses a
 * revoked one. Real Postgres; only the revoked session ends, not the user's
 * other sessions.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());
vi.mock("@/lib/rate-limit", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { cookies } from "next/headers";
import { generateToken, verifyToken, purgeExpiredRevokedTokens } from "@/lib/identity/auth";
import { requireAuth, isAuthenticated, getTenantContextFromCookies } from "@/lib/identity/route-auth";
import { POST as authPost, GET as authGet } from "@/app/api/auth/route";
import { proxy } from "@/proxy";
import { resetRateLimitsForTesting } from "@/lib/rate-limit";
import { createRequest } from "../helpers/request";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let business: SeededBusiness;

beforeAll(async () => {
  business = await seedBusiness("token-revocation");
});

afterAll(async () => {
  await prisma.revokedToken.deleteMany({ where: { userId: business.ownerUserId } });
  await cleanupBusiness(business.businessId);
});

beforeEach(async () => {
  await resetRateLimitsForTesting();
});

const authed = (token: string, path = "/api/conversations") => createRequest(path, { cookies: { "owly-token": token } });
const logout = (token: string) => authPost(createRequest("/api/auth", { method: "POST", body: { action: "logout" }, cookies: { "owly-token": token } }));

describe("token identity", () => {
  it("gives every token its own jti, readable after verification", () => {
    const a = verifyToken(generateToken(business.ownerUserId));
    const b = verifyToken(generateToken(business.ownerUserId));
    expect(a?.jti).toEqual(expect.any(String));
    expect(a?.jti).not.toBe(b?.jti);
    expect(a?.userId).toBe(business.ownerUserId);
  });
});

describe("logout revokes the presented session", () => {
  it("rejects the token on API routes after logout, with the same 401 an invalid token gets", async () => {
    const token = generateToken(business.ownerUserId);
    expect(isAuthenticated(await requireAuth(authed(token)))).toBe(true);

    const response = await logout(token);
    expect(response.status).toBe(200);
    expect(response.cookies.get("owly-token")?.value).toBe(""); // cookie still cleared

    const result = await requireAuth(authed(token));
    expect(isAuthenticated(result)).toBe(false);
    expect((result as Response).status).toBe(401);
  });

  it("does not end the user's other sessions", async () => {
    const phone = generateToken(business.ownerUserId);
    const laptop = generateToken(business.ownerUserId);
    await logout(phone);
    expect(isAuthenticated(await requireAuth(authed(laptop)))).toBe(true);
    expect(isAuthenticated(await requireAuth(authed(phone)))).toBe(false);
  });

  it("is refused for server components and /api/auth too", async () => {
    const token = generateToken(business.ownerUserId);
    const cookieStore = await cookies();
    vi.mocked(cookieStore.get).mockImplementation(((name: string) => (name === "owly-token" ? { name, value: token } : undefined)) as never);
    expect(await getTenantContextFromCookies()).not.toBeNull();
    expect((await (await authGet()).json()).authenticated).toBe(true);
    await logout(token);
    expect(await getTenantContextFromCookies()).toBeNull();
    expect((await (await authGet()).json()).authenticated).toBe(false);
    vi.mocked(cookieStore.get).mockReset();
  });

  it("is refused at the page gate (proxy) with a redirect to /login", async () => {
    const token = generateToken(business.ownerUserId);
    const page = () => proxy(new NextRequest("http://localhost:3000/", { headers: { cookie: `owly-token=${token}` } }));
    expect((await page()).headers.get("location") ?? "").not.toContain("/login");
    await logout(token);
    const after = await page();
    expect(after.status).toBeGreaterThanOrEqual(300);
    expect(after.headers.get("location") ?? "").toContain("/login");
  });

  it("records the token's own expiry so the row can be purged later, and is idempotent", async () => {
    const token = generateToken(business.ownerUserId);
    const { jti, exp } = verifyToken(token)!;
    await logout(token);
    await logout(token); // a second sign-out of the same token must not fail
    const row = await prisma.revokedToken.findUniqueOrThrow({ where: { jti: jti! } });
    expect(row.userId).toBe(business.ownerUserId);
    expect(Math.floor(row.expiresAt.getTime() / 1000)).toBe(exp);
  });
});

describe("logout with tokens that cannot be revoked", () => {
  it("clears the cookie and writes nothing for a forged token", async () => {
    const before = await prisma.revokedToken.count();
    const forged = jwt.sign({ userId: business.ownerUserId }, "attacker-secret", { jwtid: "forged-jti", expiresIn: "7d" });
    const response = await logout(forged);
    expect(response.status).toBe(200);
    expect(await prisma.revokedToken.count()).toBe(before);
  });

  it("keeps honouring a legacy token that has no jti (issued before this change) until it expires", async () => {
    const legacy = jwt.sign({ userId: business.ownerUserId }, process.env.JWT_SECRET ?? "test-only-fallback-secret", { expiresIn: "7d" });
    expect(isAuthenticated(await requireAuth(authed(legacy)))).toBe(true);
    const response = await logout(legacy);
    expect(response.status).toBe(200); // cookie cleared; nothing to record
  });

  it("logout with no cookie at all still succeeds", async () => {
    const response = await authPost(createRequest("/api/auth", { method: "POST", body: { action: "logout" } }));
    expect(response.status).toBe(200);
  });
});

describe("purging revoked tokens", () => {
  it("removes only entries whose token has already expired", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 3_600_000);
    await prisma.revokedToken.createMany({
      data: [
        { jti: "purge-expired", userId: business.ownerUserId, expiresAt: past },
        { jti: "purge-live", userId: business.ownerUserId, expiresAt: future },
      ],
    });
    const removed = await purgeExpiredRevokedTokens();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await prisma.revokedToken.findUnique({ where: { jti: "purge-expired" } })).toBeNull();
    expect(await prisma.revokedToken.findUnique({ where: { jti: "purge-live" } })).not.toBeNull();
  });
});
