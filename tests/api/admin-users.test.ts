import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma/raw-client";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { ROLES } from "@/lib/rbac/rbac";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

const INVITABLE_ROLES = ROLES.filter((r) => r !== "owner");

describe("POST /api/admin/users — role list regression (§2.4), now Membership-based (§46.1/§46.2)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "new-user",
      username: data.username,
      name: data.name,
    }));
    mockPrisma.membership.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "new-membership",
      role: data.role,
      createdAt: new Date("2026-01-01"),
    }));
  });

  it("rejects the previously-accepted 'editor' role by falling back to a real role, never persisting 'editor'", async () => {
    const { POST } = await import("@/app/api/admin/users/route");
    const request = createRequest("/api/admin/users", {
      method: "POST",
      body: { username: "newuser", password: "password123", role: "editor" },
    });

    const response = await POST(request);
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(201);
    expect(data.role).not.toBe("editor");
    expect(ROLES).toContain(data.role);
  });

  it.each(INVITABLE_ROLES)("accepts the real RBAC role '%s'", async (role) => {
    const { POST } = await import("@/app/api/admin/users/route");
    const request = createRequest("/api/admin/users", {
      method: "POST",
      body: { username: `user-${role}`, password: "password123", role },
    });

    const response = await POST(request);
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(201);
    expect(data.role).toBe(role);
  });

  it("never grants 'owner' through the generic invite flow (§9.1) — falls back to 'viewer'", async () => {
    const { POST } = await import("@/app/api/admin/users/route");
    const request = createRequest("/api/admin/users", {
      method: "POST",
      body: { username: "would-be-owner", password: "password123", role: "owner" },
    });

    const response = await POST(request);
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(201);
    expect(data.role).toBe("viewer");
  });

  it("still defaults to 'viewer' when role is omitted", async () => {
    const { POST } = await import("@/app/api/admin/users/route");
    const request = createRequest("/api/admin/users", {
      method: "POST",
      body: { username: "no-role-user", password: "password123" },
    });

    const response = await POST(request);
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(201);
    expect(data.role).toBe("viewer");
  });
});
