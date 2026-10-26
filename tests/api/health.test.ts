import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma/raw-client";
import { parseJsonResponse } from "../helpers/request";
import { NextRequest } from "next/server";

const call = (route: { GET: (r: NextRequest) => Promise<Response> }, token?: string) =>
  route.GET(new NextRequest("http://localhost:3000/api/health", { headers: token ? { "x-health-token": token } : {} }));

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

  it("recovers: ready goes 503 while the database is down and 200 again as soon as it is back", async () => {
    const { GET } = await import("@/app/api/health/ready/route");
    db(false);
    expect((await GET()).status).toBe(503);
    db(true);
    expect((await GET()).status).toBe(200);
  });

  it("the summary follows readiness: 200 with the database up, 503 when it is down", async () => {
    const route = await import("@/app/api/health/route");
    db(true);
    const ok = await call(route);
    const data = await parseJsonResponse(ok);
    expect(ok.status).toBe(200);
    // With no worker heartbeat visible the summary says "degraded" (serving, but look at the worker).
    expect(data).toMatchObject({ status: "degraded", services: { database: "ok", redis: "not_configured", worker: "unknown" } });
    // The public answer carries no fingerprinting or activity detail.
    for (const key of ["build", "memory", "uptimeSeconds", "queue", "worker", "environment"]) expect(data[key], key).toBeUndefined();
    db(false);
    const bad = await call(route);
    expect(bad.status).toBe(503);
    expect((await parseJsonResponse(bad)).status).toBe("degraded");
  });

  it("makes no outbound provider call", async () => {
    db(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const route = await import("@/app/api/health/route");
    await call(route);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns build identity and operational detail only with the operator token", async () => {
    db(true);
    process.env.APP_BUILD_SHA = "abc1234";
    process.env.HEALTH_DETAIL_TOKEN = "operator-token-for-tests-1234567890";
    const route = await import("@/app/api/health/route");
    for (const bad of [undefined, "wrong", "operator-token-for-tests-123456789"]) {
      expect((await parseJsonResponse(await call(route, bad))).build, String(bad)).toBeUndefined();
    }
    const detail = await parseJsonResponse(await call(route, "operator-token-for-tests-1234567890"));
    expect(detail.build.sha).toBe("abc1234");
    expect(detail).toHaveProperty("worker");
    expect(detail).toHaveProperty("queue");
    expect(detail.memory).toBeDefined();
    delete process.env.HEALTH_DETAIL_TOKEN;
    // No token configured: nobody gets the detail, not even an empty header.
    expect((await parseJsonResponse(await call(route, ""))).build).toBeUndefined();
    delete process.env.APP_BUILD_SHA;
  });
});
