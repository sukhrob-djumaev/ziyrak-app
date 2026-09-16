import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { fixtures } from "../helpers/fixtures";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

// Mock auth functions
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    isSetupComplete: vi.fn(),
  };
});

describe("POST /api/auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("login action", () => {
    it("should login with valid credentials", async () => {
      const { hashPassword } = await import("@/lib/auth");
      const hashedPassword = await hashPassword("admin123");

      mockPrisma.admin.findUnique.mockResolvedValue({
        ...fixtures.admin,
        password: hashedPassword,
      });

      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "login", username: "admin", password: "admin123" },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.user.username).toBe("admin");
    });

    it("should reject invalid password", async () => {
      const { hashPassword } = await import("@/lib/auth");
      const hashedPassword = await hashPassword("correctpass");

      mockPrisma.admin.findUnique.mockResolvedValue({
        ...fixtures.admin,
        password: hashedPassword,
      });

      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "login", username: "admin", password: "wrongpass" },
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it("should reject nonexistent user", async () => {
      mockPrisma.admin.findUnique.mockResolvedValue(null);

      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "login", username: "noone", password: "pass" },
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it("should reject missing credentials", async () => {
      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "login", username: "", password: "" },
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });
  });

  describe("setup action", () => {
    it("should create first admin", async () => {
      const { isSetupComplete } = await import("@/lib/auth");
      (isSetupComplete as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      mockPrisma.admin.create.mockResolvedValue({
        id: "new-admin",
        username: "newadmin",
        name: "New Admin",
        role: "admin",
      });
      mockPrisma.settings.upsert.mockResolvedValue({});
      mockPrisma.channel.upsert.mockResolvedValue({});

      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: {
          action: "setup",
          username: "newadmin",
          password: "secure123",
          name: "New Admin",
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it("should reject setup when already completed", async () => {
      const { isSetupComplete } = await import("@/lib/auth");
      (isSetupComplete as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "setup", username: "admin", password: "pass123" },
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });
  });

  describe("logout action", () => {
    it("should clear auth cookie", async () => {
      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "logout" },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  describe("invalid action", () => {
    it("should reject unknown action", async () => {
      const { POST } = await import("@/app/api/auth/route");
      const request = createRequest("/api/auth", {
        method: "POST",
        body: { action: "invalid" },
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });
  });
});

describe("GET /api/auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should return setupRequired when no admin exists", async () => {
    const { isSetupComplete, getCurrentUser } = await import("@/lib/auth");
    (isSetupComplete as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { GET } = await import("@/app/api/auth/route");
    const response = await GET();
    const data = await parseJsonResponse(response);

    expect(data.authenticated).toBe(false);
    expect(data.setupRequired).toBe(true);
  });

  it("should return authenticated user", async () => {
    const { isSetupComplete, getCurrentUser } = await import("@/lib/auth");
    (isSetupComplete as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "admin-1",
      username: "admin",
      name: "Admin",
      role: "admin",
    });

    const { GET } = await import("@/app/api/auth/route");
    const response = await GET();
    const data = await parseJsonResponse(response);

    expect(data.authenticated).toBe(true);
    expect(data.user.username).toBe("admin");
  });
});
