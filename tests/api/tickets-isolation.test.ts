import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §33.1 — tenant isolation matrix for "tickets", including §8.5's
 * assertSameTenant() check on client-supplied foreign keys (application
 * layer, 404) — the database-level proof for the same relations lives in
 * tests/repository/composite-fk-bypass.test.ts (§33.1's own bypass case).
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
  businessA = await seedBusiness("tickets-isolation-a");
  businessB = await seedBusiness("tickets-isolation-b");
  tokenA = generateToken(businessA.ownerUserId);
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

function authedRequest(path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": tokenA, ...options.cookies } });
}

describe("tenant isolation: tickets (§33.1)", () => {
  it("Business A cannot list Business B's tickets", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const ticketB = await dbB.ticket.create({ data: { title: "B-only", description: "d" } });

    const { GET } = await import("@/app/api/tickets/route");
    const response = await GET(authedRequest("/api/tickets", { searchParams: { limit: "200" } }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data.map((t: { id: string }) => t.id)).not.toContain(ticketB.id);
  });

  it("Business A cannot fetch, update, or delete Business B's ticket by known id (404)", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const ticketB = await dbB.ticket.create({ data: { title: "B-target", description: "d" } });

    const { GET, PUT, DELETE } = await import("@/app/api/tickets/[id]/route");

    const getResponse = await GET(authedRequest(`/api/tickets/${ticketB.id}`), {
      params: Promise.resolve({ id: ticketB.id }),
    });
    expect(getResponse.status).toBe(404);

    const putResponse = await PUT(
      authedRequest(`/api/tickets/${ticketB.id}`, { method: "PUT", body: { title: "hacked" } }),
      { params: Promise.resolve({ id: ticketB.id }) }
    );
    expect(putResponse.status).toBe(404);

    const deleteResponse = await DELETE(authedRequest(`/api/tickets/${ticketB.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: ticketB.id }),
    });
    expect(deleteResponse.status).toBe(404);

    const stillExists = await dbB.ticket.findUnique({ where: { id: ticketB.id } });
    expect(stillExists?.title).toBe("B-target");
  });

  it("Business A cannot create a ticket referencing Business B's TeamMember as assignedToId (application layer, §8.5)", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const departmentB = await dbB.department.create({ data: { name: "Dept B" } });
    const teamMemberB = await dbB.teamMember.create({
      data: { departmentId: departmentB.id, name: "TM B", email: "tmb@test.com" },
    });

    const { POST } = await import("@/app/api/tickets/route");
    const response = await POST(
      authedRequest("/api/tickets", {
        method: "POST",
        body: { title: "cross-tenant assign attempt", assignedToId: teamMemberB.id },
      })
    );

    expect(response.status).toBe(404);

    const dbA = getScopedPrisma(businessA.ctx);
    const leaked = await dbA.ticket.findFirst({ where: { assignedToId: teamMemberB.id } });
    expect(leaked).toBeNull();
  });

  it("Business A cannot create a ticket referencing Business B's Department", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const departmentB = await dbB.department.create({ data: { name: "Dept B2" } });

    const { POST } = await import("@/app/api/tickets/route");
    const response = await POST(
      authedRequest("/api/tickets", {
        method: "POST",
        body: { title: "cross-tenant dept attempt", departmentId: departmentB.id },
      })
    );

    expect(response.status).toBe(404);
  });

  it("Business A cannot create a ticket referencing Business B's Conversation", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const conversationB = await dbB.conversation.create({ data: { channel: "whatsapp" } });

    const { POST } = await import("@/app/api/tickets/route");
    const response = await POST(
      authedRequest("/api/tickets", {
        method: "POST",
        body: { title: "cross-tenant conv attempt", conversationId: conversationB.id },
      })
    );

    expect(response.status).toBe(404);
  });

  it("Business A cannot update its own ticket to reference Business B's TeamMember", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const dbB = getScopedPrisma(businessB.ctx);
    const ticketA = await dbA.ticket.create({ data: { title: "A-own", description: "d" } });
    const departmentB = await dbB.department.create({ data: { name: "Dept B3" } });
    const teamMemberB = await dbB.teamMember.create({
      data: { departmentId: departmentB.id, name: "TM B3", email: "tmb3@test.com" },
    });

    const { PUT } = await import("@/app/api/tickets/[id]/route");
    const response = await PUT(
      authedRequest(`/api/tickets/${ticketA.id}`, { method: "PUT", body: { assignedToId: teamMemberB.id } }),
      { params: Promise.resolve({ id: ticketA.id }) }
    );

    expect(response.status).toBe(404);
    const unchanged = await dbA.ticket.findUnique({ where: { id: ticketA.id } });
    expect(unchanged?.assignedToId).toBeNull();
  });

  it("Business A's own ticket creation with its own resources succeeds (positive control)", async () => {
    const dbA = getScopedPrisma(businessA.ctx);
    const departmentA = await dbA.department.create({ data: { name: "Dept A-own" } });

    const { POST } = await import("@/app/api/tickets/route");
    const response = await POST(
      authedRequest("/api/tickets", { method: "POST", body: { title: "same-tenant", departmentId: departmentA.id } })
    );
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(201);
    expect(data.departmentId).toBe(departmentA.id);
  });
});
