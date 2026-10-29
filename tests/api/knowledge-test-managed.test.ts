import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/** PLAN.md P2 — /api/knowledge/test must not reveal the platform model or provider error text to a managed customer. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { generateToken } from "@/lib/identity/auth";
import { aiProviderRegistry } from "@/lib/ai/providers/registry";
import { OpenAIProvider } from "@/lib/ai/providers/openai";
import { AIProviderError, type AIProvider, type CompletionResult } from "@/lib/ai/providers/types";
import { encryptAIProviderCredential } from "@/lib/ai/config";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { acquirePolicyLock, releasePolicyLock } from "../helpers/policy-lock";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let a: SeededBusiness;
let token: string;
let provider: AIProvider;

beforeAll(async () => {
  await acquirePolicyLock();
  a = await seedBusiness("knowledge-test-managed");
  token = generateToken(a.ownerUserId);
  aiProviderRegistry.register("openai", () => provider);
  const category = await prisma.category.create({ data: { businessId: a.businessId, name: "c" } });
  await prisma.knowledgeEntry.create({ data: { businessId: a.businessId, categoryId: category.id, title: "Hours", content: "Open 9 to 5." } });
});
afterAll(async () => {
  aiProviderRegistry.register("openai", ({ apiKey }) => new OpenAIProvider(apiKey));
  await prisma.aiServicePolicy.deleteMany({});
  await cleanupBusiness(a.businessId);
  await releasePolicyLock();
});
beforeEach(async () => {
  await prisma.aiServicePolicy.deleteMany({});
  await prisma.aiServicePolicy.create({
    data: {
      kind: "generation", version: 1, active: true, displayName: "Standard", provider: "openai",
      model: "secret-policy-model", credentialRef: await encryptAIProviderCredential("openai", "sk-platform-secret"),
    },
  });
  await prisma.aiUsageReservation.deleteMany({ where: { businessId: a.businessId } });
  await prisma.workspaceAiAllowance.upsert({
    where: { businessId: a.businessId },
    create: { businessId: a.businessId, mode: "managed" },
    update: { mode: "managed", status: "active" },
  });
});

const ask = () =>
  createRequest("/api/knowledge/test", { method: "POST", body: { question: "When are you open?" }, cookies: { "ziyrak-token": token } });

describe("POST /api/knowledge/test for a managed workspace", () => {
  it("omits the platform model from a successful answer", async () => {
    const ok: CompletionResult = { type: "text", text: "9 to 5", usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
    provider = { name: "fake", capabilities: { toolCalling: false, streaming: false, multimodal: false }, complete: async () => ok };
    const { POST } = await import("@/app/api/knowledge/test/route");
    const res = await POST(ask());
    const data = await parseJsonResponse(res);
    expect(res.status).toBe(200);
    expect(data.answer).toBe("9 to 5");
    expect(JSON.stringify(data)).not.toContain("secret-policy-model");
    expect(data.model).toBeUndefined();
  });

  it("returns a generic error, never provider text that can echo the platform key", async () => {
    provider = {
      name: "fake", capabilities: { toolCalling: false, streaming: false, multimodal: false },
      complete: async () => {
        throw new AIProviderError("auth", "Incorrect API key provided: sk-platform-secret-abcd. You can find your API key", false);
      },
    };
    const { POST } = await import("@/app/api/knowledge/test/route");
    const res = await POST(ask());
    const text = JSON.stringify(await parseJsonResponse(res));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(text).not.toContain("sk-");
    expect(text).not.toContain("Incorrect API key");
  });

  it("does not tell a managed customer to configure a key they cannot set", async () => {
    await prisma.aiServicePolicy.deleteMany({});
    const { POST } = await import("@/app/api/knowledge/test/route");
    const res = await POST(ask());
    const data = await parseJsonResponse(res);
    expect(res.status).toBe(503);
    expect(JSON.stringify(data)).not.toMatch(/Settings|configure it/i);
  });
});
