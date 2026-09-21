import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma/raw-client";

/**
 * Post-Phase-7 hardening (browser acceptance pass). On a fresh production
 * install no Default Business exists (nothing but the signup flow creates
 * businesses), so `assertDefaultBusinessOnly` — the fail-closed guard behind
 * the legacy `/api/settings` singleton — must answer "not available" (501)
 * for everyone. It used to `findUniqueOrThrow` the Default Business, turning
 * every dashboard load's `/api/settings` call into a 500.
 */
describe("assertDefaultBusinessOnly on an install with no Default Business", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(prisma.business.findUnique).mockReset();
    vi.mocked(prisma.business.findUniqueOrThrow).mockReset();
  });

  it("fails closed with 501 NOT_YET_SUPPORTED, not an unhandled not-found error", async () => {
    vi.mocked(prisma.business.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.business.findUniqueOrThrow).mockRejectedValue(new Error("No Business found"));
    const { assertDefaultBusinessOnly } = await vi.importActual<typeof import("@/lib/tenancy/default-business")>("@/lib/tenancy/default-business");

    const error = await assertDefaultBusinessOnly({ businessId: "some-signed-up-business" }, "Settings").catch((e) => e);

    expect(error.message).not.toContain("No Business found");
    expect(error.statusCode).toBe(501);
    expect(error.code).toBe("NOT_YET_SUPPORTED");
  });

  it("still lets the Default Business itself through and still rejects any other business", async () => {
    vi.mocked(prisma.business.findUnique).mockResolvedValue({ id: "default-id" } as never);
    vi.mocked(prisma.business.findUniqueOrThrow).mockResolvedValue({ id: "default-id" } as never);
    const { assertDefaultBusinessOnly } = await vi.importActual<typeof import("@/lib/tenancy/default-business")>("@/lib/tenancy/default-business");

    await expect(assertDefaultBusinessOnly({ businessId: "default-id" }, "Settings")).resolves.toBeUndefined();
    await expect(assertDefaultBusinessOnly({ businessId: "other-id" }, "Settings")).rejects.toMatchObject({ statusCode: 501 });
  });
});
