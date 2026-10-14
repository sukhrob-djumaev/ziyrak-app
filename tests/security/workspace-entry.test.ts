import { afterAll, describe, it, expect, vi } from "vitest";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
vi.mock("@/lib/identity/route-auth", async (original) => original());
import { POST } from "@/app/api/auth/route";
import { prisma } from "@/lib/prisma/raw-client";
import { cleanupBusiness } from "../helpers/tenant-fixtures";
import { createRequest } from "../helpers/request";
import { GET as listWorkspaces, POST as selectWorkspace } from "@/app/api/workspaces/route";
import { generateToken } from "@/lib/identity/auth";
import { seedBusiness } from "../helpers/tenant-fixtures";
const owned: string[] = [];
afterAll(async () => {
  for (const id of owned) await cleanupBusiness(id);
});
async function signup() {
  const username = "workspace-entry-" + crypto.randomUUID();
  const response = await POST(
    createRequest("/api/auth", {
      method: "POST",
      body: {
        action: "signup",
        username,
        password: "synthetic-entry-password",
        name: "Entry owner",
        businessName: "Synthetic entry workspace",
      },
    })
  );
  const data = await response.json();
  if (data.business?.id) owned.push(data.business.id);
  return { username, response, data };
}
describe("explicit workspace entry (real auth/PG)", () => {
  it("lists only own active workspaces and rejects guessed IDs or API keys", async () => {
    const a = await seedBusiness("entry-a"),
      b = await seedBusiness("entry-b");
    owned.push(a.businessId, b.businessId);
    const cookie = { "owly-token": generateToken(a.ownerUserId) };
    const request = createRequest("/api/workspaces", {
      cookies: cookie,
      workspaceSelection: false,
    });
    const listing = await listWorkspaces(request);
    const business = await prisma.business.findUniqueOrThrow({ where: { id: a.businessId } });
    expect(await listing.json()).toEqual({
      workspaces: [{ id: a.businessId, name: business.name, role: "owner" }],
    });
    const denied = await selectWorkspace(
      createRequest("/api/workspaces", {
        method: "POST",
        cookies: cookie,
        body: { workspaceId: b.businessId },
        workspaceSelection: false,
      })
    );
    expect(denied.status).toBe(403);
    expect(denied.cookies.get("ziyrak-workspace")).toBeUndefined();
    const allowed = await selectWorkspace(
      createRequest("/api/workspaces", {
        method: "POST",
        cookies: cookie,
        body: { workspaceId: a.businessId },
        workspaceSelection: false,
      })
    );
    expect(allowed.status).toBe(200);
    expect(allowed.cookies.get("ziyrak-workspace")?.value).toBe(a.businessId);
    expect(
      (
        await selectWorkspace(
          createRequest("/api/workspaces", {
            method: "POST",
            cookies: cookie,
            headers: { "x-api-key": "synthetic-key" },
            body: { workspaceId: a.businessId },
          })
        )
      ).status
    ).toBe(403);
    await prisma.membership.deleteMany({ where: { businessId: a.businessId } });
    expect(
      (
        await selectWorkspace(
          createRequest("/api/workspaces", {
            method: "POST",
            cookies: cookie,
            body: { workspaceId: a.businessId },
            workspaceSelection: false,
          })
        )
      ).status
    ).toBe(403);
  });
  it("signup selects only the workspace the person explicitly created", async () => {
    const { response, data } = await signup();
    expect(response.status).toBe(201);
    expect(response.cookies.get("ziyrak-workspace")?.value).toBe(data.business.id);
  });
  it("login with multiple memberships requires a choice and clears an old selection", async () => {
    const { username, data } = await signup();
    const other = await prisma.business.create({
      data: { name: "Second choice", slug: "second-choice-" + crypto.randomUUID() },
    });
    owned.push(other.id);
    await prisma.membership.create({
      data: { businessId: other.id, userId: data.user.id, role: "viewer" },
    });
    const response = await POST(
      createRequest("/api/auth", {
        method: "POST",
        body: {
          action: "login",
          username,
          password: "synthetic-entry-password",
        },
        cookies: { "ziyrak-workspace": data.business.id },
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspaceSelectionRequired: true });
    expect(response.cookies.get("ziyrak-workspace")?.value).toBe("");
  });
});
