import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * PLAN.md §20.1/§20.2/§46.5/§46.7 — `WhatsAppWebAdapter` drives ONE shared,
 * process-global whatsapp-web.js session. §20.2: it "is gated so it can only
 * be selected for a designated internal dev/demo `Business` (a feature flag
 * or hard allowlist check …, not a per-tenant UI toggle)"; the Phase 5 record
 * designates the Default Business (`assertDefaultBusinessOnly`), and the
 * Phase 7 runbook's feature flag (`NEXT_PUBLIC_ENABLE_WHATSAPP_WEB`, unset in
 * production) turns the whole dev/demo feature on or off.
 *
 * Regression for the status read path: `GET /api/channels/whatsapp` returned
 * the shared session's status and live QR code to ANY authenticated business
 * (only `channels:read` was checked). Scanning that QR links the scanner's
 * own WhatsApp account into the session the designated business owns.
 *
 * Real Postgres + real auth + real default-business resolution + the REAL
 * `channels/whatsapp.ts` module — only whatsapp-web.js's Puppeteer-driven
 * `Client` (and `qrcode`) are faked, so the gate under test is the
 * production gate, not a re-implementation of it in a mock.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());
vi.mock("@/lib/tenancy/default-business", async (importOriginal) => importOriginal());

type Handler = (...args: unknown[]) => unknown;
const clientHandlers: Record<string, Handler> = {};
const clientConstructed = vi.fn();
const clientSendMessage = vi.fn().mockResolvedValue(undefined);

vi.mock("whatsapp-web.js", () => {
  class MockClient {
    constructor() {
      clientConstructed();
    }
    on(event: string, handler: Handler) {
      clientHandlers[event] = handler;
    }
    async initialize() {
      // The first thing a fresh (unlinked) session does: publish a QR code.
      await clientHandlers["qr"]?.("raw-qr-payload");
    }
    destroy() {
      return Promise.resolve();
    }
    sendMessage(...args: unknown[]) {
      return clientSendMessage(...args);
    }
  }
  class MockLocalAuth {}
  return { Client: MockClient, LocalAuth: MockLocalAuth };
});

const { SHARED_SESSION_QR } = vi.hoisted(() => ({ SHARED_SESSION_QR: "data:image/png;base64,SHARED-DEMO-SESSION-QR-7731" }));
vi.mock("qrcode", () => ({ toDataURL: vi.fn().mockResolvedValue(SHARED_SESSION_QR) }));

import { generateToken } from "@/lib/identity/auth";
import { prisma } from "@/lib/prisma/raw-client";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { seedBusiness, cleanupBusiness, findOrCreateDefaultBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { whatsAppWebAdapter, disconnectWhatsApp } from "@/lib/channels/whatsapp";
import { metaCloudWhatsAppAdapter } from "@/lib/channels/meta-whatsapp-adapter";
import { getChannelAdapter } from "@/lib/channels/registry";
import { encryptChannelCredential } from "@/lib/identity/channel-credential-auth";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

const FLAG = "NEXT_PUBLIC_ENABLE_WHATSAPP_WEB";
const originalFlag = process.env[FLAG];

let bizDefault: SeededBusiness;
let bizB: SeededBusiness;
let tokenDefault: string;
let tokenB: string;
let defaultConnectionId: string;

function asDefault(path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": tokenDefault } });
}

function asB(path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": tokenB } });
}

function enableDemoFeature(enabled: boolean) {
  if (enabled) process.env[FLAG] = "true";
  else delete process.env[FLAG];
}

beforeAll(async () => {
  bizDefault = await findOrCreateDefaultBusiness();
  bizB = await seedBusiness("whatsapp-web-demo-b");
  tokenDefault = generateToken(bizDefault.ownerUserId);
  tokenB = generateToken(bizB.ownerUserId);
});

beforeEach(() => {
  clientConstructed.mockClear();
  clientSendMessage.mockClear();
});

afterAll(async () => {
  enableDemoFeature(true);
  await disconnectWhatsApp();
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;

  // bizDefault is the shared, real Default Business — only the connection
  // row this file's connect created is removed, never the business itself.
  if (defaultConnectionId) await prisma.channelConnection.deleteMany({ where: { id: defaultConnectionId } });
  await cleanupBusiness(bizB.businessId);
});

describe("WhatsApp Web (dev/demo) — feature disabled fails closed", () => {
  it("even the designated Default Business gets 404 and no session is ever started", async () => {
    enableDemoFeature(false);
    const { GET, POST } = await import("@/app/api/channels/whatsapp/route");

    const statusResponse = await GET(asDefault("/api/channels/whatsapp"));
    expect(statusResponse.status).toBe(404);

    const connectResponse = await POST(asDefault("/api/channels/whatsapp", { method: "POST", body: { action: "connect" } }));
    expect(connectResponse.status).toBe(404);
    expect(clientConstructed).not.toHaveBeenCalled();
    expect(await prisma.channelConnection.count({ where: { businessId: bizDefault.businessId, type: "whatsapp", isActive: true } })).toBe(0);

    const bStatusResponse = await GET(asB("/api/channels/whatsapp"));
    expect(bStatusResponse.status).toBe(404);
  });
});

/**
 * Follow-up to the status/QR gate: the same §20.2 invariant applies to
 * *configuration*, not only to the live session. Before this, an ordinary
 * business could save a "whatsapp" ChannelConnection through the generic
 * channel API, and `POST /api/channels/whatsapp` persisted an inactive
 * "whatsapp" row before the adapter refused the caller — safe at runtime,
 * but invalid dev-only state the product let a normal tenant create.
 */
describe("WhatsApp Web (dev/demo) — configuration is structurally gated", () => {
  type Attempt = { name: string; call: () => Promise<Response> };

  /** Every server path that could create/configure/select a "whatsapp" connection, as `token`'s business. */
  async function configurationAttempts(token: string): Promise<Attempt[]> {
    const as = (path: string, options: Parameters<typeof createRequest>[1] = {}) =>
      createRequest(path, { ...options, cookies: { "owly-token": token } });
    const channels = await import("@/app/api/channels/route");
    const typed = await import("@/app/api/channels/[type]/route");
    const web = await import("@/app/api/channels/whatsapp/route");
    const params = { params: Promise.resolve({ type: "whatsapp" }) };
    return [
      { name: "POST /api/channels", call: () => channels.POST(as("/api/channels", { method: "POST", body: { type: "whatsapp", isActive: true, config: { mode: "web" } } })) },
      { name: "PUT /api/channels/[type]", call: () => typed.PUT(as("/api/channels/whatsapp", { method: "PUT", body: { isActive: true, config: { mode: "web" } } }), params) },
      ...(["connect", "disconnect", "test"] as const).map((action) => ({
        name: `POST /api/channels/[type] ${action}`,
        call: () => typed.POST(as("/api/channels/whatsapp", { method: "POST", body: { action } }), params),
      })),
      ...(["connect", "disconnect"] as const).map((action) => ({
        name: `POST /api/channels/whatsapp ${action}`,
        call: () => web.POST(as("/api/channels/whatsapp", { method: "POST", body: { action } })),
      })),
    ];
  }

  const whatsappRowCount = (businessId: string) => prisma.channelConnection.count({ where: { businessId, type: "whatsapp" } });

  beforeAll(async () => {
    // Stale rows from earlier runs against this shared database would make
    // the "nothing persisted" assertions below vacuous.
    await prisma.channelConnection.deleteMany({ where: { businessId: { in: [bizDefault.businessId, bizB.businessId] }, type: "whatsapp" } });
  });

  it.each([
    [true, 501, "NOT_YET_SUPPORTED"],
    [false, 404, "NOT_FOUND"],
  ])("an ordinary business (feature enabled: %s) is refused on every path and no \"whatsapp\" row is ever persisted", async (flagEnabled, status, code) => {
    enableDemoFeature(flagEnabled);

    for (const attempt of await configurationAttempts(tokenB)) {
      const response = await attempt.call();
      const body = await parseJsonResponse(response);
      expect({ attempt: attempt.name, status: response.status, code: body?.error?.code }).toEqual({ attempt: attempt.name, status, code });
    }

    expect(await whatsappRowCount(bizB.businessId)).toBe(0);
    expect(clientConstructed).not.toHaveBeenCalled();
  });

  it("the designated Default Business is refused, and persists nothing, while the feature is disabled", async () => {
    enableDemoFeature(false);

    for (const attempt of await configurationAttempts(tokenDefault)) {
      const response = await attempt.call();
      expect({ attempt: attempt.name, status: response.status }).toEqual({ attempt: attempt.name, status: 404 });
    }

    // The Default Business is one shared row, and two-business-runtime-
    // isolation.test.ts (running in parallel, flag on) legitimately creates
    // its "WhatsApp Web" row through the route. So count only rows the
    // generic service would have created (named after the type); the route's
    // refuse-before-persist path is the same flag check the ordinary-business
    // case above already proves leaves nothing behind.
    expect(await prisma.channelConnection.count({ where: { businessId: bizDefault.businessId, type: "whatsapp", name: "whatsapp" } })).toBe(0);
    expect(clientConstructed).not.toHaveBeenCalled();
  });

  it("the designated Default Business can still configure WhatsApp Web through the generic API while the feature is enabled", async () => {
    enableDemoFeature(true);
    const { POST } = await import("@/app/api/channels/route");

    const response = await POST(asDefault("/api/channels", { method: "POST", body: { type: "whatsapp", isActive: false, config: { mode: "web" } } }));
    const body = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(body.type).toBe("whatsapp");
    expect(body.businessId).toBe(bizDefault.businessId);
    const saved = await prisma.channelConnection.findUnique({ where: { id: body.id } });
    expect(saved).toMatchObject({ businessId: bizDefault.businessId, type: "whatsapp", config: { mode: "web" } });
  });
});

describe("WhatsApp Web (dev/demo) — feature enabled", () => {
  it("the designated Default Business can connect and read the shared session's status and QR", async () => {
    enableDemoFeature(true);
    const { GET, POST } = await import("@/app/api/channels/whatsapp/route");

    const connectResponse = await POST(asDefault("/api/channels/whatsapp", { method: "POST", body: { action: "connect" } }));
    expect(connectResponse.status).toBe(200);
    expect(clientConstructed).toHaveBeenCalledTimes(1);

    const connection = await prisma.channelConnection.findFirst({ where: { businessId: bizDefault.businessId, type: "whatsapp" } });
    defaultConnectionId = connection!.id;

    const statusResponse = await GET(asDefault("/api/channels/whatsapp"));
    const status = await parseJsonResponse(statusResponse);
    expect(statusResponse.status).toBe(200);
    expect(status.status).toBe("qr_ready");
    expect(status.qr).toBe(SHARED_SESSION_QR);
  });

  it("an unrelated authenticated business cannot read the shared session's status or QR", async () => {
    enableDemoFeature(true);
    const { GET } = await import("@/app/api/channels/whatsapp/route");

    const response = await GET(asB("/api/channels/whatsapp"));
    const body = await parseJsonResponse(response);

    expect(response.status).toBe(501);
    expect(body.error.code).toBe("NOT_YET_SUPPORTED");
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(SHARED_SESSION_QR);
    expect(raw).not.toContain("qr_ready");
  });

  it("the adapter boundary itself refuses the unrelated business (status and outbound send), not only the route", async () => {
    enableDemoFeature(true);
    // Bring the shared session fully online for the Default Business.
    await clientHandlers["ready"]?.();

    await expect(whatsAppWebAdapter.getStatus(bizB.ctx, "any-connection")).rejects.toMatchObject({ statusCode: 501, code: "NOT_YET_SUPPORTED" });

    // The channel API no longer lets an ordinary business create a "whatsapp"
    // row (above), but one may still exist from before that gate (written
    // directly here). Outbound callers (agent reply, campaign, follow-up)
    // resolve the adapter by that type; the shared session must never send
    // on that business's behalf.
    const dbB = getScopedPrisma(bizB.ctx);
    const bConnection = await dbB.channelConnection.create({
      data: { businessId: bizB.businessId, type: "whatsapp", name: "whatsapp", isActive: true, config: {} },
    });
    const bSend = await whatsAppWebAdapter.sendMessage(bizB.ctx, bConnection.id, "15550001111", { text: "hi from B" });
    expect(bSend.success).toBe(false);
    expect(clientSendMessage).not.toHaveBeenCalled();

    // Positive control: the designated owner of the session still sends.
    const ownerStatus = await whatsAppWebAdapter.getStatus(bizDefault.ctx, defaultConnectionId);
    expect(ownerStatus.connected).toBe(true);
    const ownerSend = await whatsAppWebAdapter.sendMessage(bizDefault.ctx, defaultConnectionId, "15550002222", { text: "hi from default" });
    expect(ownerSend.success).toBe(true);
    expect(clientSendMessage).toHaveBeenCalledTimes(1);
  });

  it("disabling the feature on a deployment with a live session still fails closed for everyone", async () => {
    enableDemoFeature(false);
    const { GET } = await import("@/app/api/channels/whatsapp/route");

    const response = await GET(asDefault("/api/channels/whatsapp"));
    expect(response.status).toBe(404);
    expect(JSON.stringify(await parseJsonResponse(response))).not.toContain(SHARED_SESSION_QR);

    await expect(whatsAppWebAdapter.getStatus(bizDefault.ctx, defaultConnectionId)).rejects.toMatchObject({ statusCode: 404 });
    const send = await whatsAppWebAdapter.sendMessage(bizDefault.ctx, defaultConnectionId, "15550002222", { text: "hi" });
    expect(send.success).toBe(false);
    expect(clientSendMessage).not.toHaveBeenCalled();
  });
});

describe("Meta Cloud WhatsApp (production path) is unaffected by the dev/demo gate", () => {
  it.each([false, true])("with the WhatsApp Web feature %s, an ordinary business's whatsapp_cloud connection works as before", async (flagEnabled) => {
    enableDemoFeature(flagEnabled);

    expect(getChannelAdapter("whatsapp_cloud")).toBe(metaCloudWhatsAppAdapter);

    const dbB = getScopedPrisma(bizB.ctx);
    const connection =
      (await dbB.channelConnection.findFirst({ where: { type: "whatsapp_cloud" } })) ??
      (await dbB.channelConnection.create({
        data: {
          businessId: bizB.businessId,
          type: "whatsapp_cloud",
          name: "WhatsApp (Cloud)",
          isActive: true,
          config: { phoneNumberId: `pn-demo-gate-${bizB.businessId}` },
          credentialRef: await encryptChannelCredential({
            type: "whatsapp_cloud",
            phoneNumberId: `pn-demo-gate-${bizB.businessId}`,
            accessToken: "fake-access-token",
            businessAccountId: "waba-demo-gate",
          }),
        },
      }));

    const status = await metaCloudWhatsAppAdapter.getStatus(bizB.ctx, connection.id);
    expect(status.connected).toBe(true);

    const { GET } = await import("@/app/api/channels/[type]/route");
    const response = await GET(asB("/api/channels/whatsapp_cloud"), { params: Promise.resolve({ type: "whatsapp_cloud" }) });
    const body = await parseJsonResponse(response);
    expect(response.status).toBe(200);
    expect(body.id).toBe(connection.id);
  });

  it.each([false, true])("with the WhatsApp Web feature %s, an ordinary business can still save its whatsapp_cloud connection through the generic API", async (flagEnabled) => {
    enableDemoFeature(flagEnabled);
    const { POST } = await import("@/app/api/channels/route");

    const response = await POST(asB("/api/channels", { method: "POST", body: { type: "whatsapp_cloud", isActive: true, config: { label: `support-${flagEnabled}` } } }));
    const body = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(body.type).toBe("whatsapp_cloud");
    // Unchanged Meta behavior: a config-only save keeps the verified routing key.
    expect(body.config).toEqual({ label: `support-${flagEnabled}`, phoneNumberId: `pn-demo-gate-${bizB.businessId}` });
  });
});
