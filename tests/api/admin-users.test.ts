import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { AppError } from "@/lib/observability/errors";

const createInvitation = vi.fn();
vi.mock("@/lib/platform/admin-users/invitations", () => ({ createInvitation: (...args: unknown[]) => createInvitation(...args) }));

/**
 * PLAN.md P3 — POST /api/admin/users is an invitation to a recipient address, never an account
 * with a password chosen by the inviter. Role, scope and authority rules are exercised against real
 * Postgres in tests/repository/invitations.test.ts; this pins the route's contract.
 */
describe("POST /api/admin/users (invitation)", () => {
  beforeEach(() => {
    createInvitation.mockReset();
    createInvitation.mockResolvedValue({ id: "inv-1", email: "new@example.test", role: "agent" });
  });

  it("invites by email and role, returning the invitation (never credentials)", async () => {
    const { POST } = await import("@/app/api/admin/users/route");
    const response = await POST(createRequest("/api/admin/users", { method: "POST", body: { email: "new@example.test", role: "agent" } }));
    const data = await parseJsonResponse(response);
    expect(response.status).toBe(201);
    expect(data.invitation).toMatchObject({ id: "inv-1", email: "new@example.test", role: "agent" });
    expect(JSON.stringify(data)).not.toMatch(/password|token/i);
    expect(createInvitation.mock.calls[0][1]).toMatchObject({ email: "new@example.test", role: "agent" });
  });

  it("requires an email, and ignores any password a caller tries to send", async () => {
    const { POST } = await import("@/app/api/admin/users/route");
    expect((await POST(createRequest("/api/admin/users", { method: "POST", body: { username: "x", password: "password123" } }))).status).toBe(400);
    await POST(createRequest("/api/admin/users", { method: "POST", body: { email: "a@example.test", role: "viewer", password: "password123", username: "x" } }));
    expect(JSON.stringify(createInvitation.mock.calls[0][1])).not.toContain("password123");
  });

  it("defaults the role to viewer when omitted and surfaces refusals from the service", async () => {
    const { POST } = await import("@/app/api/admin/users/route");
    await POST(createRequest("/api/admin/users", { method: "POST", body: { email: "a@example.test" } }));
    expect(createInvitation.mock.calls[0][1]).toMatchObject({ role: "viewer" });
    createInvitation.mockRejectedValue(new AppError(403, "FORBIDDEN", "Ownership is transferred through its own flow, not by invitation"));
    const refused = await POST(createRequest("/api/admin/users", { method: "POST", body: { email: "a@example.test", role: "owner" } }));
    expect(refused.status).toBe(403);
  });
});
