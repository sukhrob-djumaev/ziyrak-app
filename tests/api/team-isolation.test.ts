import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §33.1 — tenant isolation matrix for "team" (departments +
 * members), including §8.5's assertSameTenant() check on
 * TeamMember.departmentId.
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
  businessA = await seedBusiness("team-isolation-a");
  businessB = await seedBusiness("team-isolation-b");
  tokenA = generateToken(businessA.ownerUserId);
});

afterAll(async () => {
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

function authedRequest(path: string, options: Parameters<typeof createRequest>[1] = {}) {
  return createRequest(path, { ...options, cookies: { "owly-token": tokenA, ...options.cookies } });
}

describe("tenant isolation: team departments (§33.1)", () => {
  it("Business A cannot list Business B's departments", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const deptB = await dbB.department.create({ data: { name: "B-only" } });

    const { GET } = await import("@/app/api/team/departments/route");
    const response = await GET(authedRequest("/api/team/departments", { searchParams: { limit: "200" } }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data.map((d: { id: string }) => d.id)).not.toContain(deptB.id);
  });

  it("Business A cannot update or delete Business B's department by known id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const deptB = await dbB.department.create({ data: { name: "B-target" } });

    const { PUT, DELETE } = await import("@/app/api/team/departments/[id]/route");

    const putResponse = await PUT(
      authedRequest(`/api/team/departments/${deptB.id}`, { method: "PUT", body: { name: "hacked" } }),
      { params: Promise.resolve({ id: deptB.id }) }
    );
    expect(putResponse.status).toBe(404);

    const deleteResponse = await DELETE(
      authedRequest(`/api/team/departments/${deptB.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: deptB.id }) }
    );
    expect(deleteResponse.status).toBe(404);

    expect((await dbB.department.findUnique({ where: { id: deptB.id } }))?.name).toBe("B-target");
  });
});

describe("tenant isolation: team members (§33.1/§8.5)", () => {
  it("Business A cannot list Business B's team members", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const deptB = await dbB.department.create({ data: { name: "B-dept" } });
    const memberB = await dbB.teamMember.create({
      data: { departmentId: deptB.id, name: "B-member", email: "bm@test.com" },
    });

    const { GET } = await import("@/app/api/team/members/route");
    const response = await GET(authedRequest("/api/team/members", { searchParams: { limit: "200" } }));
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data.map((m: { id: string }) => m.id)).not.toContain(memberB.id);
  });

  it("Business A cannot create a team member referencing Business B's Department (application layer, §8.5)", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const deptB = await dbB.department.create({ data: { name: "B-dept2" } });

    const { POST } = await import("@/app/api/team/members/route");
    const response = await POST(
      authedRequest("/api/team/members", {
        method: "POST",
        body: { name: "cross", email: "cross@test.com", departmentId: deptB.id },
      })
    );

    expect(response.status).toBe(404);

    const dbA = getScopedPrisma(businessA.ctx);
    const leaked = await dbA.teamMember.findFirst({ where: { departmentId: deptB.id } });
    expect(leaked).toBeNull();
  });

  it("Business A cannot update or delete Business B's team member by known id", async () => {
    const dbB = getScopedPrisma(businessB.ctx);
    const deptB = await dbB.department.create({ data: { name: "B-dept3" } });
    const memberB = await dbB.teamMember.create({
      data: { departmentId: deptB.id, name: "B-member2", email: "bm2@test.com" },
    });

    const { PUT, DELETE } = await import("@/app/api/team/members/[id]/route");

    const putResponse = await PUT(
      authedRequest(`/api/team/members/${memberB.id}`, {
        method: "PUT",
        body: { name: "hacked", email: "bm2@test.com", departmentId: deptB.id },
      }),
      { params: Promise.resolve({ id: memberB.id }) }
    );
    expect(putResponse.status).toBe(404);

    const deleteResponse = await DELETE(
      authedRequest(`/api/team/members/${memberB.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: memberB.id }) }
    );
    expect(deleteResponse.status).toBe(404);

    expect((await dbB.teamMember.findUnique({ where: { id: memberB.id } }))?.name).toBe("B-member2");
  });
});
