import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §33.1 — tenant isolation for the "channels" module. §7.7's
 * ChannelConnection replaces the legacy, global `Channel` model these
 * routes used to read/write directly (a real cross-tenant leak: every
 * business shared the same row per type).
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/route-auth", async (importOriginal) => importOriginal());

import { generateToken } from "@/lib/auth";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

let businessA: SeededBusiness;
let businessB: SeededBusiness;
let tokenA: string;

beforeAll(async () => {
  businessA = await seedBusiness("channels-isolation-a");
  businessB = await seedBusiness("channels-isolation-b");
  tokenA = generateToken(businessA.ownerUserId);
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

function authedRequest(path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": tokenA, ...options.cookies } });
}

describe("tenant isolation: channels (§33.1)", () => {
  it("Business A configuring 'whatsapp' does not see or affect Business B's whatsapp connection", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    await dbB.channelConnection.create({
      data: { type: "whatsapp", name: "whatsapp", isActive: true, status: "connected", config: { secret: "b-secret" } },
    });

    const { GET, PUT } = await import("@/app/api/channels/[type]/route");

    const getResponse = await GET(authedRequest("/api/channels/whatsapp"), {
      params: Promise.resolve({ type: "whatsapp" }),
    });
    const getData = await parseJsonResponse(getResponse);

    // Business A has no connection yet — must see the empty placeholder,
    // never Business B's real config/secret.
    expect(getData.status).toBe("disconnected");
    expect(getData.config).toEqual({});

    const putResponse = await PUT(
      authedRequest("/api/channels/whatsapp", { method: "PUT", body: { config: { secret: "a-secret" } } }),
      { params: Promise.resolve({ type: "whatsapp" }) }
    );
    expect(putResponse.status).toBe(200);

    const bConnection = await dbB.channelConnection.findFirst({ where: { type: "whatsapp" } });
    expect((bConnection?.config as Record<string, unknown>)?.secret).toBe("b-secret");
  });

  it("Business A's channel list never includes Business B's connections", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    await dbB.channelConnection.create({ data: { type: "telegram", name: "telegram", status: "connected" } });

    const { GET } = await import("@/app/api/channels/route");
    const response = await GET(authedRequest("/api/channels"));
    const data = await parseJsonResponse(response);

    const telegramEntry = data.find((c: { type: string }) => c.type === "telegram");
    expect(telegramEntry.status).toBe("disconnected");
    expect(telegramEntry.id).toBeNull();
  });
});
