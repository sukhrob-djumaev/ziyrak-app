import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §33.1 — the dashboard homepage (a React Server Component, not an
 * API route) used to query conversation/ticket/message counts with zero
 * tenant filtering at all — every business's stats and recent
 * conversations were visible to every other business's users. Verifies
 * `getTenantContextFromCookies()` + `getScopedPrisma(ctx)` closes this.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());
vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

import { generateToken } from "@/lib/identity/auth";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

let businessA: SeededBusiness;
let businessB: SeededBusiness;
let tokenA: string;

beforeAll(async () => {
  businessA = await seedBusiness("dashboard-isolation-a");
  businessB = await seedBusiness("dashboard-isolation-b");
  tokenA = generateToken(businessA.ownerUserId);
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

describe("tenant isolation: dashboard homepage Server Component", () => {
  it("getTenantContextFromCookies() + getScopedPrisma() never surfaces Business B's conversations to Business A", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    await dbB.conversation.create({ data: { channel: "whatsapp", customerName: "B-only-on-dashboard" } });

    const { cookies } = await import("next/headers");
    (cookies as ReturnType<typeof vi.fn>).mockResolvedValue({
      get: (name: string) => (name === "owly-token" ? { value: tokenA } : undefined),
    });

    const { getTenantContextFromCookies } = await import("@/lib/identity/route-auth");
    const ctx = await getTenantContextFromCookies();

    expect(ctx).not.toBeNull();
    expect(ctx!.businessId).toBe(businessA.businessId);

    const dbA = getScopedPrisma(ctx!);
    const conversations = await dbA.conversation.findMany({ take: 10, orderBy: { updatedAt: "desc" } });

    expect(conversations.every((c) => c.customerName !== "B-only-on-dashboard")).toBe(true);
  });

  it("returns null when there is no valid session cookie", async () => {
    const { cookies } = await import("next/headers");
    (cookies as ReturnType<typeof vi.fn>).mockResolvedValue({
      get: () => undefined,
    });

    const { getTenantContextFromCookies } = await import("@/lib/identity/route-auth");
    const ctx = await getTenantContextFromCookies();

    expect(ctx).toBeNull();
  });
});
