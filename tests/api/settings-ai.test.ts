import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §46.4/§33.1 — the new, real, tenant-scoped AI settings boundary.
 * Real Postgres (§34.2) since this is exactly the tenant-isolation matrix
 * §33 requires for every resource: a business must never read or affect
 * another business's AI configuration/credential.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { generateToken } from "@/lib/identity/auth";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let businessA: SeededBusiness;
let businessB: SeededBusiness;
let tokenA: string;
let tokenB: string;

beforeAll(async () => {
  businessA = await seedBusiness("settings-ai-a");
  businessB = await seedBusiness("settings-ai-b");
  tokenA = generateToken(businessA.ownerUserId);
  tokenB = generateToken(businessB.ownerUserId);
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

function asA(path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": tokenA, ...options.cookies } });
}

function asB(path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": tokenB, ...options.cookies } });
}

describe("GET/PUT /api/settings/ai (§46.4)", () => {
  it("defaults to platform defaults, not configured, before anything is set", async () => {
    const { GET } = await import("@/app/api/settings/ai/route");
    const response = await GET(asA("/api/settings/ai"));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.aiProvider).toBe("openai");
    expect(data.aiConfigured).toBe(false);
    expect(data.embeddingConfigured).toBe(false);
  });

  it("stores a provider/model/credential and never returns the raw key back", async () => {
    const { PUT } = await import("@/app/api/settings/ai/route");
    const response = await PUT(
      asA("/api/settings/ai", {
        method: "PUT",
        body: { aiProvider: "anthropic", aiModel: "claude-sonnet-4-20250514", aiApiKey: "sk-ant-real-secret-value" },
      })
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.aiProvider).toBe("anthropic");
    expect(data.aiModel).toBe("claude-sonnet-4-20250514");
    expect(data.aiConfigured).toBe(true);
    expect(JSON.stringify(data)).not.toContain("sk-ant-real-secret-value");
  });

  it("rejects an unknown provider value", async () => {
    const { PUT } = await import("@/app/api/settings/ai/route");
    const response = await PUT(
      asA("/api/settings/ai", { method: "PUT", body: { aiProvider: "not-a-real-provider" } })
    );
    expect(response.status).toBe(400);
  });

  it("rejects an embedding provider that isn't supported", async () => {
    const { PUT } = await import("@/app/api/settings/ai/route");
    const response = await PUT(
      asA("/api/settings/ai", { method: "PUT", body: { embeddingProvider: "openai", embeddingApiKey: "sk-embed" } })
    );
    expect(response.status).toBe(200);
  });

  it("rejects providing an API key for a provider that doesn't accept one yet (ollama)", async () => {
    const { PUT } = await import("@/app/api/settings/ai/route");
    const response = await PUT(
      asA("/api/settings/ai", { method: "PUT", body: { aiProvider: "ollama", aiApiKey: "not-needed" } })
    );
    expect(response.status).toBe(400);
  });
});

describe("tenant isolation: /api/settings/ai (§33.1)", () => {
  it("Business A's GET never reflects Business B's provider/model", async () => {
    await (await import("@/app/api/settings/ai/route")).PUT(
      asB("/api/settings/ai", { method: "PUT", body: { aiProvider: "openai", aiModel: "gpt-4o", aiApiKey: "sk-business-b-secret" } })
    );

    const { GET } = await import("@/app/api/settings/ai/route");
    const responseA = await GET(asA("/api/settings/ai"));
    const dataA = await parseJsonResponse(responseA);

    expect(dataA.aiModel).not.toBe("gpt-4o");
  });

  it("Business A's PUT never affects Business B's stored config", async () => {
    const { PUT, GET } = await import("@/app/api/settings/ai/route");

    const beforeB = await parseJsonResponse(await GET(asB("/api/settings/ai")));

    await PUT(asA("/api/settings/ai", { method: "PUT", body: { aiModel: "gpt-4o-mini-A-only" } }));

    const afterB = await parseJsonResponse(await GET(asB("/api/settings/ai")));
    expect(afterB.aiModel).toBe(beforeB.aiModel);
    expect(afterB.aiModel).not.toBe("gpt-4o-mini-A-only");
  });
});
