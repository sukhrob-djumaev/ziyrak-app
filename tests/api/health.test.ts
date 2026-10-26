import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma/raw-client";
import { parseJsonResponse } from "../helpers/request";

const mockPrisma = prisma as unknown as { $queryRaw: ReturnType<typeof vi.fn> };
const db = (ok: boolean) =>
  ok ? mockPrisma.$queryRaw.mockResolvedValue([{ "?column?": 1 }]) : mockPrisma.$queryRaw.mockRejectedValue(new Error("Connection refused"));

/** L2.1 / F04: liveness never consults a dependency; readiness and the summary fail with 503 when the database is down. */
describe("health probes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.REDIS_URL;
  });

  it("live answers 200 even when the database is down and never queries it", async () => {
    db(false);
    mockPrisma.$queryRaw.mockClear();
    const { GET } = await import("@/app/api/health/live/route");
    const response = GET();
    expect(response.status).toBe(200);
    expect((await parseJsonResponse(response)).status).toBe("alive");
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("ready is 200 with the database up and 503 when it is down", async () => {
    const { GET } = await import("@/app/api/health/ready/route");
    db(true);
    const up = await GET();
    expect(up.status).toBe(200);
    expect(await parseJsonResponse(up)).toMatchObject({ status: "ready", checks: { database: "ok" } });
    db(false);
    const down = await GET();
    expect(down.status).toBe(503);
    expect(await parseJsonResponse(down)).toMatchObject({ status: "not_ready", checks: { database: "down" } });
  });

  it("the summary follows readiness: 200 with the database up, 503 when it is down", async () => {
    const { GET } = await import("@/app/api/health/route");
    db(true);
    const ok = await GET();
    const data = await parseJsonResponse(ok);
    expect(ok.status).toBe(200);
    // With no worker heartbeat visible the summary says "degraded" (serving, but look at the worker).
    expect(data).toMatchObject({ status: "degraded", services: { database: "ok", redis: "not_configured", worker: "unknown" } });
    expect(data.build).toBeDefined();
    expect(data.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(data.memory).toBeDefined();
    db(false);
    const bad = await GET();
    expect(bad.status).toBe(503);
    expect((await parseJsonResponse(bad)).status).toBe("degraded");
  });

  it("makes no outbound provider call", async () => {
    db(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { GET } = await import("@/app/api/health/route");
    await GET();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports the deployed build identity from the environment", async () => {
    db(true);
    process.env.APP_BUILD_SHA = "abc1234";
    const { GET } = await import("@/app/api/health/route");
    expect((await parseJsonResponse(await GET())).build.sha).toBe("abc1234");
    delete process.env.APP_BUILD_SHA;
  });
});
