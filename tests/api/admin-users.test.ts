import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { ROLES } from "@/lib/rbac";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

describe("POST /api/admin/users — role list regression (§2.4)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPrisma.admin.findUnique.mockResolvedValue(null);
    mockPrisma.admin.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "new-admin",
      username: data.username,
      name: data.name,
      role: data.role,
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

  it.each(ROLES)("accepts the real RBAC role '%s'", async (role) => {
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
