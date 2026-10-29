import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
vi.mock("@/lib/identity/route-auth", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { generateToken } from "@/lib/identity/auth";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { createRequest } from "../helpers/request";
let a: SeededBusiness, b: SeededBusiness, c: SeededBusiness, token: string;
beforeAll(async () => {
  a = await seedBusiness("p1-select-a");
  b = await seedBusiness("p1-select-b");
  c = await seedBusiness("p1-select-c");
  await prisma.membership.create({
    data: { businessId: b.businessId, userId: a.ownerUserId, role: "viewer" },
  });
  token = generateToken(a.ownerUserId);
});
afterAll(async () => {
  for (const row of [a, b, c]) if (row) await cleanupBusiness(row.businessId);
});
function req(workspace?: string) {
  return createRequest("/api/conversations", {
    workspaceSelection: false,
    cookies: { "ziyrak-token": token, ...(workspace ? { "ziyrak-workspace": workspace } : {}) },
  });
}
describe("explicit workspace selection (real identity/Postgres)", () => {
  it("resolves the selected current membership and its own role", async () => {
    const ctx = await requireAuth(req(b.businessId), "conversations:read");
    expect(isAuthenticated(ctx)).toBe(true);
    if (isAuthenticated(ctx)) {
      expect(ctx.businessId).toBe(b.businessId);
      expect(ctx.role).toBe("viewer");
    }
  });
  it("requires an explicit selection rather than earliest membership", async () => {
    const r = await requireAuth(req());
    expect(isAuthenticated(r)).toBe(false);
    if (!isAuthenticated(r)) expect(r.status).toBe(409);
  });
  it("rejects a guessed workspace without falling back to another membership", async () => {
    const r = await requireAuth(req(c.businessId));
    expect(isAuthenticated(r)).toBe(false);
    if (!isAuthenticated(r)) expect(r.status).toBe(403);
  });
  it("does not borrow owner permissions from another selected membership", async () => {
    const r = await requireAuth(req(b.businessId), "settings:update");
    expect(isAuthenticated(r)).toBe(false);
    if (!isAuthenticated(r)) expect(r.status).toBe(403);
  });
  it("revocation of the selected membership does not fall back to remaining access", async () => {
    await prisma.membership.delete({
      where: { businessId_userId: { businessId: b.businessId, userId: a.ownerUserId } },
    });
    const r = await requireAuth(req(b.businessId));
    expect(isAuthenticated(r)).toBe(false);
    if (!isAuthenticated(r)) expect(r.status).toBe(403);
  });
});
