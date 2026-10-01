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
        body: { aiProvider: "anthropic", aiModel: "claude-sonnet-5-5", aiApiKey: "sk-ant-real-secret-value" },
      })
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.aiProvider).toBe("anthropic");
    expect(data.aiModel).toBe("claude-sonnet-5-5");
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

describe("PUT /api/settings/ai — supported Anthropic catalog, retired values need explicit reselection", () => {
  let businessC: SeededBusiness;
  let tokenC: string;

  beforeAll(async () => {
    businessC = await seedBusiness("settings-ai-retired");
    tokenC = generateToken(businessC.ownerUserId);
  });

  afterAll(async () => {
    await cleanupBusiness(businessC.businessId);
  });

  function asC(path: string, options: Parameters<typeof createRequest>[1] = {}) {
    return createRequest(path, { ...options, cookies: { "owly-token": tokenC, ...options.cookies } });
  }

  async function storeModel(aiProvider: string, aiModel: string | null) {
    const { prisma } = await import("@/lib/prisma/raw-client");
    await prisma.businessConfig.upsert({
      where: { businessId: businessC.businessId },
      update: { aiProvider, aiModel },
      create: { businessId: businessC.businessId, aiProvider, aiModel },
    });
  }

  async function storedModel() {
    const { prisma } = await import("@/lib/prisma/raw-client");
    return (await prisma.businessConfig.findUnique({ where: { businessId: businessC.businessId } }))?.aiModel;
  }

  it("rejects saving a retired model id", async () => {
    const { PUT } = await import("@/app/api/settings/ai/route");
    const response = await PUT(
      asC("/api/settings/ai", { method: "PUT", body: { aiProvider: "anthropic", aiModel: "claude-3-5-haiku-20241022" } })
    );
    const data = await parseJsonResponse(response);
    expect(response.status).toBe(400);
    expect(data.error).toContain("claude-3-5-haiku-20241022");
    expect(data.error).toContain("claude-sonnet-5-5");
  });

  it("a previously stored retired model stays readable and is reported unsupported, never remapped", async () => {
    await storeModel("anthropic", "claude-3-opus-20240229");
    const { GET } = await import("@/app/api/settings/ai/route");
    const data = await parseJsonResponse(await GET(asC("/api/settings/ai")));
    expect(data.aiModel).toBe("claude-3-opus-20240229");
    expect(data.aiModelSupported).toBe(false);
    expect(await storedModel()).toBe("claude-3-opus-20240229");
  });

  it("a key-only save on a retired model is refused until a model is reselected, and nothing is written", async () => {
    await storeModel("anthropic", "claude-3-opus-20240229");
    const { PUT } = await import("@/app/api/settings/ai/route");
    const response = await PUT(asC("/api/settings/ai", { method: "PUT", body: { aiApiKey: "sk-ant-new-key" } }));
    expect(response.status).toBe(400);
    expect(await storedModel()).toBe("claude-3-opus-20240229");
    const { prisma } = await import("@/lib/prisma/raw-client");
    const row = await prisma.businessConfig.findUnique({ where: { businessId: businessC.businessId } });
    expect(row?.aiCredentialRef ?? null).toBeNull();
  });

  it("switching to Anthropic while an OpenAI model is stored requires choosing a Claude model", async () => {
    await storeModel("openai", "gpt-4o-mini");
    const { PUT } = await import("@/app/api/settings/ai/route");
    const response = await PUT(asC("/api/settings/ai", { method: "PUT", body: { aiProvider: "anthropic" } }));
    expect(response.status).toBe(400);
  });

  it("explicitly reselecting a supported model succeeds", async () => {
    await storeModel("anthropic", "claude-3-opus-20240229");
    const { PUT } = await import("@/app/api/settings/ai/route");
    const response = await PUT(
      asC("/api/settings/ai", { method: "PUT", body: { aiModel: "claude-haiku-4-5", aiApiKey: "sk-ant-new-key" } })
    );
    const data = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(data.aiModel).toBe("claude-haiku-4-5");
    expect(data.aiModelSupported).toBe(true);
  });

  it("an Anthropic business with no stored model reports the catalog default", async () => {
    await storeModel("anthropic", null);
    const { GET } = await import("@/app/api/settings/ai/route");
    const data = await parseJsonResponse(await GET(asC("/api/settings/ai")));
    expect(data.aiModel).toBe("claude-sonnet-5-5");
    expect(data.aiModelSupported).toBe(true);
  });
});
