import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * Post-Phase-7 browser acceptance defect: `/settings` answered 501 for every
 * business created through signup, so an owner could not edit the business
 * profile or AI configuration after onboarding. Root cause: the page read
 * and wrote the legacy single-tenant `Settings` singleton through
 * `/api/settings`, which `assertDefaultBusinessOnly` (correctly) fail-closes
 * for everyone but the Default Business — and a fresh install has none.
 *
 * The profile fields live in the tenant-scoped `BusinessConfig`
 * (§46.4/§10.2). `/api/settings/business` is their tenant-scoped boundary,
 * alongside the existing `/api/settings/ai`. Real Postgres (§34.2): the
 * isolation matrix is the point.
 *
 * The default-business module is replaced with a faithful *fresh install*:
 * no Default Business exists, so any route that so much as asks for its id
 * fails the test — proving the settings boundary has no Default Business
 * fallback — and the legacy guard answers exactly as it does on a fresh
 * install (501).
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

const defaultBusinessLookups = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/lib/tenancy/default-business", async () => {
  const { AppError } = await import("@/lib/observability/errors");
  return {
    getDefaultBusinessId: vi.fn(async () => {
      defaultBusinessLookups.count += 1;
      throw new Error("getDefaultBusinessId() called: a tenant settings route fell back to the Default Business");
    }),
    isDefaultBusiness: vi.fn(async () => false),
    assertDefaultBusinessOnly: vi.fn(async (_ctx: unknown, featureLabel: string) => {
      throw new AppError(501, "NOT_YET_SUPPORTED", `${featureLabel} is not yet available for businesses other than the first one.`);
    }),
    getDefaultBusinessContext: vi.fn(),
  };
});

import { generateToken } from "@/lib/identity/auth";
import { prisma } from "@/lib/prisma/raw-client";
import { provisionBusiness } from "@/lib/platform/provisioning";
import { resolveAIConfig } from "@/lib/ai/config";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { addMember, cleanupBusiness } from "../helpers/tenant-fixtures";

interface SignedUp {
  businessId: string;
  userId: string;
  token: string;
}

async function signUp(label: string, profile: { businessName: string; businessDesc: string; welcomeMessage: string; tone: string }): Promise<SignedUp> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const provisioned = await provisionBusiness({
    ownerUsername: `${label}-${suffix}`,
    ownerPassword: "not-a-real-login-password",
    ownerName: "Owner",
    ...profile,
  });
  return { businessId: provisioned.businessId, userId: provisioned.userId, token: generateToken(provisioned.userId) };
}

let bakery: SignedUp;
let scooters: SignedUp;
let viewerToken: string;

beforeAll(async () => {
  bakery = await signUp("settings-biz-a", {
    businessName: "Sunrise Bakery",
    businessDesc: "Sourdough and pastries",
    welcomeMessage: "Welcome to the bakery!",
    tone: "friendly",
  });
  scooters = await signUp("settings-biz-b", {
    businessName: "Volt Scooters",
    businessDesc: "Electric scooters and repairs",
    welcomeMessage: "Ride on!",
    tone: "technical",
  });
  const viewer = await addMember(bakery.businessId, "viewer", "settings-viewer");
  viewerToken = generateToken(viewer.userId);
});

afterAll(async () => {
  await cleanupBusiness(bakery.businessId);
  await cleanupBusiness(scooters.businessId);
});

function as(token: string, path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": token, ...options.cookies } });
}

describe("GET/PUT /api/settings/business — a signed-up business edits its own profile", () => {
  it("reads the profile the owner entered at signup, with no Default Business involved", async () => {
    const { GET } = await import("@/app/api/settings/business/route");
    const response = await GET(as(bakery.token, "/api/settings/business"));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      businessName: "Sunrise Bakery",
      businessDesc: "Sourdough and pastries",
      welcomeMessage: "Welcome to the bakery!",
      tone: "friendly",
      language: "auto",
    });
    expect(defaultBusinessLookups.count).toBe(0);
  });

  it("persists an edit to the caller's own BusinessConfig and reads it back", async () => {
    const { GET, PUT } = await import("@/app/api/settings/business/route");
    const put = await PUT(
      as(bakery.token, "/api/settings/business", {
        method: "PUT",
        body: { businessName: "Sunrise Bakery & Café", tone: "professional", language: "en", welcomeMessage: "Hello, friend!" },
      })
    );
    const putData = await parseJsonResponse(put);

    expect(put.status).toBe(200);
    expect(putData).toMatchObject({ businessName: "Sunrise Bakery & Café", tone: "professional", language: "en", welcomeMessage: "Hello, friend!" });
    // a partial update leaves the other fields alone
    expect(putData.businessDesc).toBe("Sourdough and pastries");

    const row = await prisma.businessConfig.findUnique({ where: { businessId: bakery.businessId } });
    expect(row).toMatchObject({ businessName: "Sunrise Bakery & Café", tone: "professional", language: "en" });

    const again = await parseJsonResponse(await GET(as(bakery.token, "/api/settings/business")));
    expect(again.businessName).toBe("Sunrise Bakery & Café");
    expect(defaultBusinessLookups.count).toBe(0);
  });

  it("rejects invalid values, unknown fields, and any attempt to name a tenant in the body", async () => {
    const { PUT } = await import("@/app/api/settings/business/route");
    const bad = async (body: Record<string, unknown>) =>
      (await PUT(as(bakery.token, "/api/settings/business", { method: "PUT", body }))).status;

    expect(await bad({ tone: "sarcastic" })).toBe(400);
    expect(await bad({ businessName: "x" })).toBe(400);
    expect(await bad({ businessName: "y".repeat(101) })).toBe(400);
    expect(await bad({ businessId: scooters.businessId, businessName: "Hijack" })).toBe(400);
    expect(await bad({ aiCredentialRef: "anything" })).toBe(400);
    expect(await bad({ retentionDays: 1 })).toBe(400);

    const other = await prisma.businessConfig.findUnique({ where: { businessId: scooters.businessId } });
    expect(other?.businessName).toBe("Volt Scooters");
  });

  it("requires authentication and an admin-level role", async () => {
    const { GET, PUT } = await import("@/app/api/settings/business/route");

    expect((await GET(createRequest("/api/settings/business"))).status).toBe(401);
    expect((await PUT(createRequest("/api/settings/business", { method: "PUT", body: { tone: "formal" } }))).status).toBe(401);

    expect((await GET(as(viewerToken, "/api/settings/business"))).status).toBe(403);
    const viewerPut = await PUT(as(viewerToken, "/api/settings/business", { method: "PUT", body: { businessName: "Viewer Edit" } }));
    expect(viewerPut.status).toBe(403);
    const row = await prisma.businessConfig.findUnique({ where: { businessId: bakery.businessId } });
    expect(row?.businessName).not.toBe("Viewer Edit");
  });
});

describe("tenant isolation: /api/settings/business", () => {
  it("one business's edit never reaches another's profile, in either direction", async () => {
    const { GET, PUT } = await import("@/app/api/settings/business/route");

    await PUT(as(scooters.token, "/api/settings/business", { method: "PUT", body: { businessName: "Volt Scooters Ltd", tone: "formal" } }));

    const seenByBakery = await parseJsonResponse(await GET(as(bakery.token, "/api/settings/business")));
    expect(seenByBakery.businessName).toBe("Sunrise Bakery & Café");
    expect(seenByBakery.tone).toBe("professional");

    await PUT(as(bakery.token, "/api/settings/business", { method: "PUT", body: { businessDesc: "Bread only" } }));
    const seenByScooters = await parseJsonResponse(await GET(as(scooters.token, "/api/settings/business")));
    expect(seenByScooters.businessName).toBe("Volt Scooters Ltd");
    expect(seenByScooters.businessDesc).toBe("Electric scooters and repairs");
  });

  it("a query-string businessId is ignored: the caller's own business is always the one read", async () => {
    const { GET } = await import("@/app/api/settings/business/route");
    const data = await parseJsonResponse(
      await GET(as(bakery.token, "/api/settings/business", { searchParams: { businessId: scooters.businessId } }))
    );
    expect(data.businessName).toBe("Sunrise Bakery & Café");
  });
});

describe("AI configuration for a signed-up business (/api/settings/ai)", () => {
  it("is editable, resolves through the SecretResolver, and never exposes the key", async () => {
    const { GET, PUT } = await import("@/app/api/settings/ai/route");
    const secret = "sk-signup-business-secret-0123456789";

    const put = await PUT(
      as(bakery.token, "/api/settings/ai", {
        method: "PUT",
        body: { aiProvider: "openai", aiModel: "gpt-4o-mini", aiApiKey: secret, temperature: 0.4 },
      })
    );
    expect(put.status).toBe(200);
    const putBody = JSON.stringify(await parseJsonResponse(put));
    expect(putBody).not.toContain(secret);

    const getBody = JSON.stringify(await parseJsonResponse(await GET(as(bakery.token, "/api/settings/ai"))));
    expect(getBody).not.toContain(secret);
    expect(JSON.parse(getBody)).toMatchObject({ aiConfigured: true, aiModel: "gpt-4o-mini", temperature: 0.4 });

    // stored as an opaque SecretResolver reference, never plaintext
    const row = await prisma.businessConfig.findUnique({ where: { businessId: bakery.businessId } });
    expect(row?.aiCredentialRef).toBeTruthy();
    expect(row?.aiCredentialRef).not.toContain(secret);

    // …and it round-trips to the runtime AI config for that business only
    const resolved = await resolveAIConfig({
      businessId: bakery.businessId,
      role: "owner",
      actor: { kind: "user", userId: bakery.userId },
      dataConnection: "shared-default",
    });
    expect(resolved.apiKey).toBe(secret);

    const other = await parseJsonResponse(await GET(as(scooters.token, "/api/settings/ai")));
    expect(other.aiConfigured).toBe(false);
    expect(defaultBusinessLookups.count).toBe(0);
  });
});

describe("the legacy single-tenant /api/settings stays constrained", () => {
  it("still answers 501 to a signed-up business and never touches the legacy Settings row", async () => {
    const before = await prisma.settings.findUnique({ where: { id: "default" } });

    const { GET, PUT } = await import("@/app/api/settings/route");
    const get = await GET(as(bakery.token, "/api/settings"));
    const put = await PUT(as(bakery.token, "/api/settings", { method: "PUT", body: { businessName: "Legacy Write" } }));

    expect(get.status).toBe(501);
    expect(put.status).toBe(501);

    const after = await prisma.settings.findUnique({ where: { id: "default" } });
    expect(after?.businessName).toBe(before?.businessName);
    expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
  });
});
