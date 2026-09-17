import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * Phase 2 final runtime-isolation audit — the invariant under test:
 *
 *   "Any externally reachable path after Phase 2 must either operate
 *   using the authenticated/resolved tenant context, or fail closed for
 *   tenants for which that path is not yet supported. It must never
 *   silently fall back to the Default Business."
 *
 * Unlike tests/api/*-isolation.test.ts (Business A vs. Business B, both
 * ordinary tenants), this suite specifically exercises the Default
 * Business itself as one of the two tenants, because the paths under
 * audit (assertDefaultBusinessOnly()'s call sites: /api/chat,
 * /api/settings, /api/knowledge/test, WhatsApp connect/disconnect) branch
 * on "is this caller the Default Business", not on ordinary per-row
 * scoping. Real Postgres + real auth + real default-business resolution
 * (see the three unmocks below) — the point is to prove what actually
 * gets persisted, not just the HTTP response shape.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/route-auth", async (importOriginal) => importOriginal());
vi.mock("@/lib/default-business", async (importOriginal) => importOriginal());

const mockOpenAICreateFn = vi.fn();
vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockOpenAICreateFn } };
  },
}));

vi.mock("@/lib/channels/whatsapp", () => ({
  getWhatsAppStatus: vi.fn().mockReturnValue({ status: "disconnected", qr: null, message: "" }),
  initWhatsApp: vi.fn().mockResolvedValue(undefined),
  disconnectWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

import { generateToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma/raw-client";
import { createRequest, parseJsonResponse } from "../helpers/request";
import {
  seedBusiness,
  cleanupBusiness,
  findOrCreateDefaultBusiness,
  type SeededBusiness,
} from "../helpers/tenant-fixtures";
import * as apiKeysService from "@/lib/admin-api-keys/service";
import * as whatsappLib from "@/lib/channels/whatsapp";

let bizDefault: SeededBusiness;
let bizB: SeededBusiness;
let tokenDefault: string;
let tokenB: string;
let defaultCategoryId: string;

const DEFAULT_KNOWLEDGE_MARKER = "DEFAULT-BUSINESS-KNOWLEDGE-MARKER-4471";
const BIZ_B_KNOWLEDGE_MARKER = "BIZ-B-KNOWLEDGE-MARKER-9902";

beforeAll(async () => {
  bizDefault = await findOrCreateDefaultBusiness();
  bizB = await seedBusiness("runtime-isolation-b");
  tokenDefault = generateToken(bizDefault.ownerUserId);
  tokenB = generateToken(bizB.ownerUserId);

  // A real-looking AI key so chat()/knowledge-test's `!config.apiKey` early
  // return doesn't short-circuit before reaching the code this suite
  // exists to exercise. OpenAI itself is mocked (above) — no network call.
  await prisma.settings.upsert({
    where: { id: "default" },
    update: { aiApiKey: "sk-test-runtime-isolation", aiProvider: "openai", aiModel: "gpt-4o-mini" },
    create: { id: "default", aiApiKey: "sk-test-runtime-isolation", aiProvider: "openai", aiModel: "gpt-4o-mini" },
  });

  const defaultCategory = await prisma.category.create({
    data: { businessId: bizDefault.businessId, name: "runtime-isolation-default-cat" },
  });
  defaultCategoryId = defaultCategory.id;
  await prisma.knowledgeEntry.create({
    data: {
      businessId: bizDefault.businessId,
      categoryId: defaultCategoryId,
      title: "Default entry",
      content: DEFAULT_KNOWLEDGE_MARKER,
      isActive: true,
    },
  });

  const bCategory = await prisma.category.create({
    data: { businessId: bizB.businessId, name: "runtime-isolation-b-cat" },
  });
  await prisma.knowledgeEntry.create({
    data: {
      businessId: bizB.businessId,
      categoryId: bCategory.id,
      title: "B entry",
      content: BIZ_B_KNOWLEDGE_MARKER,
      isActive: true,
    },
  });
});

afterAll(async () => {
  // bizDefault is the one real, shared Default Business (analogous to
  // production's first business) — never delete it. Only the rows this
  // file added to it are cleaned up; bizB is fully owned by this file and
  // is torn down completely.
  await prisma.knowledgeEntry.deleteMany({ where: { businessId: bizDefault.businessId, categoryId: defaultCategoryId } });
  await prisma.category.deleteMany({ where: { businessId: bizDefault.businessId, id: defaultCategoryId } });
  await prisma.settings.update({ where: { id: "default" }, data: { aiApiKey: "" } }).catch(() => {});
  await cleanupBusiness(bizB.businessId);
});

function asDefault(path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": tokenDefault, ...options.cookies } });
}

function asB(path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": tokenB, ...options.cookies } });
}

describe("Phase 2 runtime-isolation audit: /api/chat", () => {
  it("Default Business: chat succeeds, persists Conversation+Message rows under its own businessId, and the AI prompt carries only its own knowledge", async () => {
    mockOpenAICreateFn.mockResolvedValueOnce({
      choices: [{ finish_reason: "stop", message: { content: "Default AI reply" } }],
    });

    const { POST } = await import("@/app/api/chat/route");
    const response = await POST(
      asDefault("/api/chat", { method: "POST", body: { message: "Hello from the Default Business caller" } })
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.response).toBe("Default AI reply");

    const conversation = await prisma.conversation.findUnique({ where: { id: data.conversationId } });
    expect(conversation?.businessId).toBe(bizDefault.businessId);

    const messages = await prisma.message.findMany({ where: { conversationId: data.conversationId } });
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message.businessId).toBe(bizDefault.businessId);
    }
    expect(messages.map((m) => m.role).sort()).toEqual(["assistant", "customer"]);

    const systemPrompt = mockOpenAICreateFn.mock.calls[0][0].messages[0].content as string;
    expect(systemPrompt).toContain(DEFAULT_KNOWLEDGE_MARKER);
    expect(systemPrompt).not.toContain(BIZ_B_KNOWLEDGE_MARKER);
  });

  it("Business B: chat is rejected (501, fail closed) and never creates any row under the Default Business or calls the AI provider", async () => {
    const beforeDefaultConvCount = await prisma.conversation.count({ where: { businessId: bizDefault.businessId } });
    const beforeBConvCount = await prisma.conversation.count({ where: { businessId: bizB.businessId } });
    mockOpenAICreateFn.mockClear();

    const { POST } = await import("@/app/api/chat/route");
    const response = await POST(
      asB("/api/chat", { method: "POST", body: { message: "Business B secret message" } })
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(501);
    expect(data.error.code).toBe("NOT_YET_SUPPORTED");

    const afterDefaultConvCount = await prisma.conversation.count({ where: { businessId: bizDefault.businessId } });
    const afterBConvCount = await prisma.conversation.count({ where: { businessId: bizB.businessId } });
    expect(afterDefaultConvCount).toBe(beforeDefaultConvCount);
    expect(afterBConvCount).toBe(beforeBConvCount);
    expect(mockOpenAICreateFn).not.toHaveBeenCalled();
  });
});

describe("Phase 2 runtime-isolation audit: /api/settings", () => {
  it("Default Business: can read and update Settings", async () => {
    const { GET, PUT } = await import("@/app/api/settings/route");

    const getResponse = await GET(asDefault("/api/settings"));
    expect(getResponse.status).toBe(200);

    const putResponse = await PUT(
      asDefault("/api/settings", { method: "PUT", body: { businessName: "Default Biz Runtime Isolation" } })
    );
    expect(putResponse.status).toBe(200);

    const settings = await prisma.settings.findUnique({ where: { id: "default" } });
    expect(settings?.businessName).toBe("Default Biz Runtime Isolation");
  });

  it("Business B: rejected (501) on both GET and PUT; Settings row is left completely unchanged by the attempted write", async () => {
    const before = await prisma.settings.findUnique({ where: { id: "default" } });

    const { GET, PUT } = await import("@/app/api/settings/route");

    const getResponse = await GET(asB("/api/settings"));
    const getData = await parseJsonResponse(getResponse);
    expect(getResponse.status).toBe(501);
    expect(getData.error.code).toBe("NOT_YET_SUPPORTED");

    const putResponse = await PUT(
      asB("/api/settings", { method: "PUT", body: { businessName: "HACKED BY BUSINESS B" } })
    );
    const putData = await parseJsonResponse(putResponse);
    expect(putResponse.status).toBe(501);
    expect(putData.error.code).toBe("NOT_YET_SUPPORTED");

    const after = await prisma.settings.findUnique({ where: { id: "default" } });
    expect(after?.businessName).toBe(before?.businessName);
    expect(after?.businessName).not.toBe("HACKED BY BUSINESS B");
  });
});

describe("Phase 2 runtime-isolation audit: /api/knowledge/test", () => {
  it("Default Business: can test its own (correctly isolated) knowledge base", async () => {
    mockOpenAICreateFn.mockClear();
    mockOpenAICreateFn.mockResolvedValueOnce({
      choices: [{ message: { content: "Here is the answer.\n---SOURCES---\n[1]" } }],
    });

    const { POST } = await import("@/app/api/knowledge/test/route");
    const response = await POST(
      asDefault("/api/knowledge/test", { method: "POST", body: { question: "What do you know?" } })
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.sources).toHaveLength(1);
    expect(data.sources[0].title).toBe("Default entry");
  });

  it("Business B: rejected (501) before the AI provider is ever called — never tested against the Default Business's AI key/billing", async () => {
    mockOpenAICreateFn.mockClear();

    const { POST } = await import("@/app/api/knowledge/test/route");
    const response = await POST(
      asB("/api/knowledge/test", { method: "POST", body: { question: "What do you know?" } })
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(501);
    expect(data.error.code).toBe("NOT_YET_SUPPORTED");
    expect(mockOpenAICreateFn).not.toHaveBeenCalled();
  });
});

describe("Phase 2 runtime-isolation audit: /api/channels/whatsapp connect/disconnect", () => {
  it("Default Business: can connect/disconnect the shared WhatsApp session", async () => {
    const { POST } = await import("@/app/api/channels/whatsapp/route");

    const connectResponse = await POST(asDefault("/api/channels/whatsapp", { method: "POST", body: { action: "connect" } }));
    expect(connectResponse.status).toBe(200);
    expect(whatsappLib.initWhatsApp).toHaveBeenCalled();
  });

  it("Business B: rejected (501) and never touches the shared WhatsApp session another business depends on", async () => {
    (whatsappLib.initWhatsApp as ReturnType<typeof vi.fn>).mockClear();
    (whatsappLib.disconnectWhatsApp as ReturnType<typeof vi.fn>).mockClear();

    const { POST, GET } = await import("@/app/api/channels/whatsapp/route");

    const connectResponse = await POST(asB("/api/channels/whatsapp", { method: "POST", body: { action: "connect" } }));
    const connectData = await parseJsonResponse(connectResponse);
    expect(connectResponse.status).toBe(501);
    expect(connectData.error.code).toBe("NOT_YET_SUPPORTED");
    expect(whatsappLib.initWhatsApp).not.toHaveBeenCalled();

    const disconnectResponse = await POST(asB("/api/channels/whatsapp", { method: "POST", body: { action: "disconnect" } }));
    expect(disconnectResponse.status).toBe(501);
    expect(whatsappLib.disconnectWhatsApp).not.toHaveBeenCalled();

    // Read-only status is intentionally left ungated (no tenant data, no
    // control-plane write) — confirms that's a deliberate choice, not an
    // oversight, by checking it succeeds where the mutating actions don't.
    const statusResponse = await GET(asB("/api/channels/whatsapp"));
    expect(statusResponse.status).toBe(200);
  });
});

describe("Phase 2 runtime-isolation audit: standard (non-guarded) CRUD persists the caller's own businessId", () => {
  it("Business B's customer creation persists under Business B's own businessId, never the Default Business's", async () => {
    const { POST } = await import("@/app/api/customers/route");
    const response = await POST(asB("/api/customers", { method: "POST", body: { name: "B Customer Runtime Isolation" } }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(201);

    const persisted = await prisma.customer.findUnique({ where: { id: data.id } });
    expect(persisted?.businessId).toBe(bizB.businessId);
    expect(persisted?.businessId).not.toBe(bizDefault.businessId);
  });
});

describe("Phase 2 runtime-isolation audit: API keys resolve to their own business, never silently to the Default Business", () => {
  it("Business B's API key hitting /api/chat resolves to Business B's own context and is fail-closed there too (not silently treated as Default)", async () => {
    const { fullKey } = await apiKeysService.create(bizB.ctx, "runtime-isolation-b-key");
    mockOpenAICreateFn.mockClear();

    const { POST } = await import("@/app/api/chat/route");
    const response = await POST(
      createRequest("/api/chat", { method: "POST", headers: { "x-api-key": fullKey }, body: { message: "via api key" } })
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(501);
    expect(data.error.code).toBe("NOT_YET_SUPPORTED");
    expect(mockOpenAICreateFn).not.toHaveBeenCalled();
  });

  it("the Default Business's own API key correctly succeeds on the same route (symmetric proof — the guard checks identity, not the auth mechanism)", async () => {
    const { fullKey } = await apiKeysService.create(bizDefault.ctx, "runtime-isolation-default-key");
    mockOpenAICreateFn.mockClear();
    mockOpenAICreateFn.mockResolvedValueOnce({
      choices: [{ finish_reason: "stop", message: { content: "Default AI reply via API key" } }],
    });

    const { POST } = await import("@/app/api/chat/route");
    const response = await POST(
      createRequest("/api/chat", { method: "POST", headers: { "x-api-key": fullKey }, body: { message: "via api key" } })
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.response).toBe("Default AI reply via API key");

    const conversation = await prisma.conversation.findUnique({ where: { id: data.conversationId } });
    expect(conversation?.businessId).toBe(bizDefault.businessId);
  });
});
