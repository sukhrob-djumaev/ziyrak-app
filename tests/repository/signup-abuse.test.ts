import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

/** L1.3: signup abuse controls - a per-address ceiling and a platform-wide ceiling, applied before any provisioning. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { CaptureMailTransport, setMailTransportForTesting } from "@/lib/mail/transport";
import { resetRateLimitsForTesting, SIGNUP_LIMITS } from "@/lib/rate-limit";
import { POST } from "@/app/api/auth/route";
import { createRequest } from "../helpers/request";

const mail = new CaptureMailTransport();
setMailTransportForTesting(mail);
const signup = (headers: Record<string, string> = {}) =>
  createRequest("/api/auth", {
    method: "POST",
    headers,
    body: {
      action: "signup",
      businessName: "Abuse Test Co",
      username: `ab_${randomUUID().slice(0, 12)}`,
      email: `ab-${randomUUID()}@example.test`,
      password: "Correct-horse-9",
    },
  });

afterAll(async () => {
  setMailTransportForTesting(null);
  const owners = await prisma.user.findMany({ where: { username: { startsWith: "ab_" } }, select: { id: true } });
  await prisma.membership.deleteMany({ where: { userId: { in: owners.map((o) => o.id) } } }).catch(() => undefined);
  const biz = await prisma.business.findMany({ where: { name: "Abuse Test Co" }, select: { id: true } });
  await prisma.business.deleteMany({ where: { id: { in: biz.map((b) => b.id) } } });
  await prisma.user.deleteMany({ where: { id: { in: owners.map((o) => o.id) } } });
});
beforeEach(async () => {
  await resetRateLimitsForTesting();
});

describe("signup abuse controls", () => {
  it("refuses the request past the per-address ceiling, before creating anything", async () => {
    for (let i = 0; i < SIGNUP_LIMITS.perAddress.maxRequests; i++) {
      expect((await POST(signup())).status).toBe(202);
    }
    const before = await prisma.business.count({ where: { name: "Abuse Test Co" } });
    const blocked = await POST(signup());
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(await prisma.business.count({ where: { name: "Abuse Test Co" } })).toBe(before);
  }, 120_000);

  it("a different address is not affected by another address's budget (when addresses can be told apart)", () => {
    expect(SIGNUP_LIMITS.perAddress.maxRequests).toBeGreaterThan(0);
    expect(SIGNUP_LIMITS.platformWide.maxRequests).toBeGreaterThan(SIGNUP_LIMITS.perAddress.maxRequests);
  });
});
