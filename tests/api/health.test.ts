import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { parseJsonResponse } from "../helpers/request";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>> | ReturnType<typeof vi.fn>>;

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Mock settings for OpenAI check
    (mockPrisma.settings as Record<string, ReturnType<typeof vi.fn>>).findFirst.mockResolvedValue({ aiApiKey: "" });
  });

  it("should return ok status when database is connected", async () => {
    (mockPrisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ "?column?": 1 }]);

    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.status).toBe("ok");
    expect(data.services.database).toBe("connected");
    expect(data.uptime).toBeDefined();
    expect(data.memory).toBeDefined();
    expect(data.environment).toBeDefined();
  });

  it("should return degraded status when database is down", async () => {
    (mockPrisma.$queryRaw as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Connection refused"));

    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.status).toBe("degraded");
    expect(data.services.database).toBe("error");
  });

  it("should report openai as not_configured when no API key", async () => {
    (mockPrisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ "?column?": 1 }]);
    (mockPrisma.settings as Record<string, ReturnType<typeof vi.fn>>).findFirst.mockResolvedValue({ aiApiKey: "" });

    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    const data = await parseJsonResponse(response);

    expect(data.services.openai).toBe("not_configured");
  });
});
