import { describe, it, expect, vi, afterAll } from "vitest";
import crypto from "crypto";

// Real Postgres, real route handlers, real auth: signup is the trust boundary
// that creates tenants, so nothing here is mocked below the HTTP layer.
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());
vi.mock("@/lib/tenancy/default-business", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { requireAuth } from "@/lib/identity/route-auth";
import { verifyPassword } from "@/lib/identity/auth";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { DEFAULT_TOOL_POLICIES } from "@/lib/tools/policy";
import { generateBusinessSlug } from "@/lib/platform/provisioning";
import { cleanupBusiness } from "../helpers/tenant-fixtures";
import { NextRequest } from "next/server";

/**
 * PLAN.md §46.7 task 3/acceptance: a real signup creates an isolated,
 * fully-formed business — its own Business, owner Membership, shared-default
 * TenantPlacement, BusinessConfig and ToolPolicy rows — atomically, and
 * nothing about it is copied from, or shared with, any other tenant.
 */

const createdBusinessIds: string[] = [];
const uniq = () => crypto.randomBytes(5).toString("hex");

async function signup(overrides: Record<string, unknown> = {}) {
  const { POST } = await import("@/app/api/auth/route");
  const body = {
    action: "signup",
    businessName: `Acme ${uniq()}`,
    username: `owner-${uniq()}`,
    password: "a-decent-password",
    name: "Owner",
    ...overrides,
  };
  const response = await POST(createRequest("/api/auth", { method: "POST", body }));
  const data = await parseJsonResponse(response);
  if (data.business?.id) createdBusinessIds.push(data.business.id);
  return { response, data, body };
}

function cookieOf(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  return /owly-token=([^;]+)/.exec(raw)?.[1] ?? "";
}

afterAll(async () => {
  for (const id of createdBusinessIds) await cleanupBusiness(id);
});

describe("signup creates a complete, isolated business (§46.7)", () => {
  it("creates Business + shared-default TenantPlacement + owner Membership + BusinessConfig + ToolPolicy rows", async () => {
    const { response, data, body } = await signup({ businessDesc: "We sell kettles", welcomeMessage: "Hi from Acme!", tone: "professional" });
    expect(response.status).toBe(201);
    const businessId = data.business.id as string;

    const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    expect(business.status).toBe("active");
    expect(business.name).toBe(body.businessName);
    expect(business.slug).not.toBe("default");
    expect(business.slug).toMatch(/^acme-[0-9a-f]+-[0-9a-f]{8}$/);

    const placement = await prisma.tenantPlacement.findUniqueOrThrow({ where: { businessId } });
    expect(placement.databaseProfileId).toBe("shared-default");
    expect(placement.storageProfileId).toBe("shared-default");

    const memberships = await prisma.membership.findMany({ where: { businessId } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ userId: data.user.id, role: "owner" });

    const config = await prisma.businessConfig.findUniqueOrThrow({ where: { businessId } });
    expect(config).toMatchObject({
      businessName: body.businessName,
      businessDesc: "We sell kettles",
      welcomeMessage: "Hi from Acme!",
      tone: "professional",
      aiProvider: null,
      aiCredentialRef: null,
    });

    // Complete rows for every real tool, identical to the code defaults —
    // and none for the synthetic approval-test tool.
    const policies = await prisma.toolPolicy.findMany({ where: { businessId } });
    const expectedTools = Object.keys(DEFAULT_TOOL_POLICIES).filter((t) => t !== "noop_test_action").sort();
    expect(policies.map((p) => p.tool).sort()).toEqual(expectedTools);
    for (const row of policies) {
      const expected = DEFAULT_TOOL_POLICIES[row.tool];
      expect({
        enabledForTenant: row.enabledForTenant,
        allowedForAI: row.allowedForAI,
        allowedForHumanRoles: row.allowedForHumanRoles,
        requiresHumanApproval: row.requiresHumanApproval,
      }).toEqual(expected);
    }
  });

  it("the password is stored only as a bcrypt hash, and the new owner is signed in as that business's owner", async () => {
    const { response, data } = await signup({ password: "correct horse battery" });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: data.user.id } });
    expect(user.password).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery", user.password)).toBe(true);

    const ctx = await requireAuth(createRequest("/api/anything", { cookies: { "owly-token": cookieOf(response) } }));
    expect(ctx).toMatchObject({ businessId: data.business.id, role: "owner", actor: { kind: "user", userId: data.user.id } });
  });

  it("copies nothing from another tenant: no channel connections, customers, knowledge, or config values", async () => {
    const first = await signup();
    // Give the first business real data of every kind a naive "clone the default" implementation might copy.
    const firstId = first.data.business.id as string;
    await prisma.channelConnection.create({ data: { businessId: firstId, type: "sms", name: "sms", isActive: true, config: { phoneNumber: "+15550001" }, credentialRef: "secret-ref" } });
    await prisma.customer.create({ data: { businessId: firstId, name: "First's customer" } });
    await prisma.businessConfig.update({ where: { businessId: firstId }, data: { aiProvider: "anthropic", aiCredentialRef: "first-ai-secret" } });

    const second = await signup();
    const secondId = second.data.business.id as string;

    expect(await prisma.channelConnection.count({ where: { businessId: secondId } })).toBe(0);
    expect(await prisma.customer.count({ where: { businessId: secondId } })).toBe(0);
    expect(await prisma.conversation.count({ where: { businessId: secondId } })).toBe(0);
    expect(await prisma.knowledgeEntry.count({ where: { businessId: secondId } })).toBe(0);
    const config = await prisma.businessConfig.findUniqueOrThrow({ where: { businessId: secondId } });
    expect(config.aiCredentialRef).toBeNull();
    expect(config.aiProvider).toBeNull();
  });

  it("ignores client-supplied tenant/role fields — the caller cannot join an existing business, pick a role, or become a platform admin", async () => {
    const victim = await signup();
    const { data } = await signup({ businessId: victim.data.business.id, role: "viewer", isPlatformAdmin: true, slug: "default", planId: "enterprise" });

    expect(data.business.id).not.toBe(victim.data.business.id);
    const memberships = await prisma.membership.findMany({ where: { userId: data.user.id } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ businessId: data.business.id, role: "owner" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: data.user.id } })).isPlatformAdmin).toBe(false);
    const business = await prisma.business.findUniqueOrThrow({ where: { id: data.business.id } });
    expect(business.slug).not.toBe("default");
    expect(business.planId).toBeNull();
    // The victim's membership list is unchanged: still exactly its own owner.
    expect(await prisma.membership.count({ where: { businessId: victim.data.business.id } })).toBe(1);
  });

  it("a business named 'Default' can never claim the reserved default-business slug", async () => {
    for (const name of ["Default", "default", "  DEFAULT  ", "de/fault"]) {
      const { data } = await signup({ businessName: name });
      const business = await prisma.business.findUniqueOrThrow({ where: { id: data.business.id } });
      expect(business.slug).not.toBe("default");
    }
    expect(generateBusinessSlug("Default")).toMatch(/^default-[0-9a-f]{8}$/);
  });

  it("allows two businesses with the same display name (distinct slugs), but never the same username", async () => {
    const name = `Twin Cafe ${uniq()}`;
    const a = await signup({ businessName: name });
    const b = await signup({ businessName: name });
    expect(a.response.status).toBe(201);
    expect(b.response.status).toBe(201);
    const [rowA, rowB] = await Promise.all([
      prisma.business.findUniqueOrThrow({ where: { id: a.data.business.id } }),
      prisma.business.findUniqueOrThrow({ where: { id: b.data.business.id } }),
    ]);
    expect(rowA.slug).not.toBe(rowB.slug);

    const username = `dup-${uniq()}`;
    expect((await signup({ username })).response.status).toBe(201);
    const ghost = `Should Not Exist ${uniq()}`;
    const again = await signup({ username, businessName: ghost });
    expect(again.response.status).toBe(409);
    // Case variants are the same person too.
    expect((await signup({ username: username.toUpperCase(), businessName: `${ghost} 2` })).response.status).toBe(409);
    expect(await prisma.business.count({ where: { name: { startsWith: ghost } } })).toBe(0);
  });

  it("is atomic under a race: two simultaneous signups for one username leave exactly one business and no orphans", async () => {
    const username = `race-${uniq()}`;
    const tag = uniq();
    const [x, y] = await Promise.all([
      signup({ username, businessName: `Race Biz X ${tag}` }),
      signup({ username, businessName: `Race Biz Y ${tag}` }),
    ]);
    expect([x.response.status, y.response.status].sort()).toEqual([201, 409]);

    expect(await prisma.business.count({ where: { name: { contains: tag } } })).toBe(1);
    const winner = x.response.status === 201 ? x : y;
    const loser = x.response.status === 201 ? y : x;
    expect(await prisma.user.count({ where: { username } })).toBe(1);
    expect(await prisma.membership.count({ where: { businessId: winner.data.business.id } })).toBe(1);
    expect(await prisma.toolPolicy.count({ where: { businessId: winner.data.business.id } })).toBeGreaterThan(0);
    expect(loser.data.business).toBeUndefined();
    // No business row exists without a placement, owner, config, or policies.
    const orphans = await prisma.business.findMany({
      where: { name: { contains: tag }, OR: [{ placement: null }, { config: null }, { memberships: { none: {} } }, { toolPolicies: { none: {} } }] },
    });
    expect(orphans).toHaveLength(0);
  });

  it("existing login for an existing business still works after signup was added", async () => {
    const { data, body } = await signup({ password: "login-still-works" });
    const { POST } = await import("@/app/api/auth/route");
    const response = await POST(createRequest("/api/auth", { method: "POST", body: { action: "login", username: body.username, password: "login-still-works" } }));
    expect(response.status).toBe(200);
    const ctx = await requireAuth(createRequest("/api/anything", { cookies: { "owly-token": cookieOf(response) } }));
    expect(ctx).toMatchObject({ businessId: data.business.id, role: "owner" });
  });

  it("rejects malformed signups before creating anything", async () => {
    const ghost = `Malformed ${uniq()}`;
    for (const bad of [
      { businessName: "" },
      { businessName: "x" },
      { businessName: ghost, username: "ab" },
      { businessName: ghost, username: "has space" },
      { businessName: ghost, password: "short" },
    ]) {
      expect((await signup(bad)).response.status).toBe(400);
    }
    expect(await prisma.business.count({ where: { name: ghost } })).toBe(0);
  });

  it("creates an owner who can immediately use the API as that business, and no other", async () => {
    const a = await signup();
    const b = await signup();
    const ctxA = (await requireAuth(new NextRequest("http://localhost/api/x", { headers: { cookie: `owly-token=${cookieOf(a.response)}` } }))) as { businessId: string };
    const ctxB = (await requireAuth(new NextRequest("http://localhost/api/x", { headers: { cookie: `owly-token=${cookieOf(b.response)}` } }))) as { businessId: string };
    expect(ctxA.businessId).toBe(a.data.business.id);
    expect(ctxB.businessId).toBe(b.data.business.id);
    expect(ctxA.businessId).not.toBe(ctxB.businessId);
  });
});
