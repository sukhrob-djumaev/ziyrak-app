import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma/raw-client";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { fixtures } from "../helpers/fixtures";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

// Mock auth functions
vi.mock("@/lib/identity/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/identity/auth")>();
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    isSetupComplete: vi.fn(),
  };
});

vi.mock("@/lib/platform/provisioning", () => ({ provisionBusiness: vi.fn() }));

describe("POST /api/auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("login action", () => {
    it("should login with valid credentials", async () => {
      const { hashPassword } = await import("@/lib/identity/auth");
      const hashedPassword = await hashPassword("admin123");

      mockPrisma.user.findUnique.mockResolvedValue({
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
      const { hashPassword } = await import("@/lib/identity/auth");
      const hashedPassword = await hashPassword("correctpass");

      mockPrisma.user.findUnique.mockResolvedValue({
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
      mockPrisma.user.findUnique.mockResolvedValue(null);

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

  describe("signup action (PLAN.md §46.7 task 3)", () => {
    const validSignup = { action: "signup", businessName: "Acme", username: "newowner", password: "secure1234", name: "New Owner" };

    it("creates a business through provisioning and signs the owner in", async () => {
      const { provisionBusiness } = await import("@/lib/platform/provisioning");
      (provisionBusiness as ReturnType<typeof vi.fn>).mockResolvedValue({ businessId: "biz-new", slug: "acme-1234", userId: "new-user" });
      mockPrisma.user.findUniqueOrThrow = vi.fn().mockResolvedValue({ id: "new-user", username: "newowner", name: "New Owner" });

      const { POST } = await import("@/app/api/auth/route");
      const response = await POST(createRequest("/api/auth", { method: "POST", body: validSignup }));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
      expect(data.business).toEqual({ id: "biz-new", name: "Acme" });
      expect(response.headers.get("set-cookie")).toContain("owly-token=");
      expect(provisionBusiness).toHaveBeenCalledWith(expect.objectContaining({ businessName: "Acme", ownerUsername: "newowner" }));
    });

    it("stays open after a business already exists (no single-installation gate)", async () => {
      const { isSetupComplete } = await import("@/lib/identity/auth");
      (isSetupComplete as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const { provisionBusiness } = await import("@/lib/platform/provisioning");
      (provisionBusiness as ReturnType<typeof vi.fn>).mockResolvedValue({ businessId: "biz-2", slug: "second-1", userId: "u2" });
      mockPrisma.user.findUniqueOrThrow = vi.fn().mockResolvedValue({ id: "u2", username: "second", name: "Second" });

      const { POST } = await import("@/app/api/auth/route");
      const response = await POST(createRequest("/api/auth", { method: "POST", body: { ...validSignup, username: "second" } }));
      expect(response.status).toBe(201);
    });

    it("never forwards a client-supplied business id or role to provisioning", async () => {
      const { provisionBusiness } = await import("@/lib/platform/provisioning");
      (provisionBusiness as ReturnType<typeof vi.fn>).mockResolvedValue({ businessId: "biz-3", slug: "x-1", userId: "u3" });
      mockPrisma.user.findUniqueOrThrow = vi.fn().mockResolvedValue({ id: "u3", username: "newowner", name: "N" });

      const { POST } = await import("@/app/api/auth/route");
      await POST(createRequest("/api/auth", { method: "POST", body: { ...validSignup, businessId: "victim", role: "owner", isPlatformAdmin: true } }));

      const input = (provisionBusiness as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
      expect(JSON.stringify(input)).not.toContain("victim");
      expect(input).not.toHaveProperty("role");
      expect(input).not.toHaveProperty("isPlatformAdmin");
    });

    it("reports a taken username as 409", async () => {
      const { provisionBusiness } = await import("@/lib/platform/provisioning");
      const { AppError } = await import("@/lib/observability/errors");
      (provisionBusiness as ReturnType<typeof vi.fn>).mockRejectedValue(new AppError(409, "USERNAME_TAKEN", "That username is already taken."));

      const { POST } = await import("@/app/api/auth/route");
      const response = await POST(createRequest("/api/auth", { method: "POST", body: validSignup }));
      expect(response.status).toBe(409);
    });

    it("rejects an invalid body before provisioning anything", async () => {
      const { provisionBusiness } = await import("@/lib/platform/provisioning");
      (provisionBusiness as ReturnType<typeof vi.fn>).mockClear();

      const { POST } = await import("@/app/api/auth/route");
      const response = await POST(createRequest("/api/auth", { method: "POST", body: { action: "signup", username: "x", password: "short" } }));
      expect(response.status).toBe(400);
      expect(provisionBusiness).not.toHaveBeenCalled();
    });

    it("the old one-time 'setup' action no longer exists", async () => {
      const { POST } = await import("@/app/api/auth/route");
      const response = await POST(createRequest("/api/auth", { method: "POST", body: { action: "setup", username: "admin", password: "pass1234" } }));
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

  it("should return setupRequired (a first-visit hint only) when no business exists yet", async () => {
    const { isSetupComplete, getCurrentUser } = await import("@/lib/identity/auth");
    (isSetupComplete as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { GET } = await import("@/app/api/auth/route");
    const response = await GET();
    const data = await parseJsonResponse(response);

    expect(data.authenticated).toBe(false);
    expect(data.setupRequired).toBe(true);
  });

  it("should return authenticated user", async () => {
    const { isSetupComplete, getCurrentUser } = await import("@/lib/identity/auth");
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
