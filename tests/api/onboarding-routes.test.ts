import { describe, it, expect, vi, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

/** PLAN.md P3 — onboarding routes: authenticated persons only, own workspace only, owner-gated actions. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { provisionBusiness } from "@/lib/platform/provisioning";
import { generateToken } from "@/lib/identity/auth";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { recordWorkspaceSelection } from "../helpers/workspace-selection";

const businessIds: string[] = [];
const userIds: string[] = [];
async function signedUp() {
  const r = await provisionBusiness({
    businessName: "Route Co", ownerUsername: `rt_${randomUUID().slice(0, 12)}`, ownerPassword: "Correct-horse-9", ownerEmail: `rt-${randomUUID()}@example.test`,
  });
  businessIds.push(r.businessId);
  userIds.push(r.userId);
  recordWorkspaceSelection(r.userId, r.businessId);
  return { ...r, token: generateToken(r.userId) };
}
const as = (path: string, token: string, method = "GET") => createRequest(path, { method, body: method === "POST" ? {} : undefined, cookies: { "owly-token": token } });
afterAll(async () => {
  await prisma.business.deleteMany({ where: { id: { in: businessIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("onboarding routes", () => {
  it("rejects anonymous callers", async () => {
    const { GET } = await import("@/app/api/onboarding/route");
    const { POST } = await import("@/app/api/onboarding/activate/route");
    expect((await GET(createRequest("/api/onboarding"))).status).toBe(401);
    expect((await POST(createRequest("/api/onboarding/activate", { method: "POST", body: {} }))).status).toBe(401);
  });

  it("shows each owner only their own workspace's state", async () => {
    const { GET } = await import("@/app/api/onboarding/route");
    const a = await signedUp();
    const b = await signedUp();
    await prisma.channelConnection.create({ data: { businessId: a.businessId, type: "webchat", name: "A", isActive: true } });
    const viewA = await parseJsonResponse(await GET(as("/api/onboarding", a.token)));
    const viewB = await parseJsonResponse(await GET(as("/api/onboarding", b.token)));
    expect(viewA.steps.find((s: { id: string }) => s.id === "channel").status).toBe("done");
    expect(viewB.steps.find((s: { id: string }) => s.id === "channel").status).toBe("pending");
    expect(JSON.stringify(viewA)).not.toContain(b.businessId);
  });

  it("refuses activation with a safe, specific reason when the email is not verified", async () => {
    const { POST } = await import("@/app/api/onboarding/activate/route");
    const a = await signedUp();
    const res = await POST(as("/api/onboarding/activate", a.token, "POST"));
    const body = await parseJsonResponse(res);
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("EMAIL_NOT_VERIFIED");
    expect((await prisma.onboardingState.findUniqueOrThrow({ where: { businessId: a.businessId } })).activatedAt).toBeNull();
  });

  it("refuses the test reply for a non-owner member", async () => {
    const { POST } = await import("@/app/api/onboarding/test-reply/route");
    const a = await signedUp();
    const agent = await prisma.user.create({ data: { username: `ag_${randomUUID().slice(0, 12)}`, password: "x", name: "Agent", email: `ag-${randomUUID()}@example.test`, emailVerifiedAt: new Date() } });
    userIds.push(agent.id);
    await prisma.membership.create({ data: { businessId: a.businessId, userId: agent.id, role: "agent" } });
    recordWorkspaceSelection(agent.id, a.businessId);
    const res = await POST(createRequest("/api/onboarding/test-reply", { method: "POST", body: {}, cookies: { "owly-token": generateToken(agent.id) } }));
    expect(res.status).toBe(403);
    expect((await parseJsonResponse(res)).error.code).toBe("OWNER_REQUIRED");
  });
});
