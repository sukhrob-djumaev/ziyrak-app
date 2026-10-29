import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToReadableStream } from "react-dom/server";
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/prisma/raw-client", async (original) => original());
vi.mock("@/lib/identity/route-auth", async (original) => original());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error("FIXTURE_REDIRECT:" + path);
  },
  usePathname: () => "/admin",
  useRouter: () => ({ refresh() {}, replace() {} }),
}));
vi.mock("@/components/layout/header", () => ({
  Header: ({ title }: { title: string }) => React.createElement("header", null, title),
}));
import { prisma } from "@/lib/prisma/raw-client";
import { generateToken, revokeToken } from "@/lib/identity/auth";
import {
  seedBusiness,
  addMember,
  cleanupBusiness,
  type SeededBusiness,
} from "../helpers/tenant-fixtures";
import AdminPage from "@/app/(dashboard)/admin/page";
import DashboardLayout from "@/app/(dashboard)/layout";

let fixture: SeededBusiness;
const actors = new Map<string, string>();
beforeAll(async () => {
  // Next builds use the automatic JSX runtime; Vitest's standalone SSR transform
  // may use classic JSX for the unchanged existing page/client modules.
  vi.stubGlobal("React", React);
  fixture = await seedBusiness("p1-administration-presentation");
  actors.set("owner", fixture.ownerUserId);
  for (const role of ["admin", "supervisor", "agent", "viewer"])
    actors.set(role, (await addMember(fixture.businessId, role, "presentation-" + role)).userId);
});
afterEach(() => {
  jar.clear();
  vi.restoreAllMocks();
});
afterAll(async () => {
  if (fixture) await cleanupBusiness(fixture.businessId);
  vi.unstubAllGlobals();
});
function select(userId: string) {
  jar.set("ziyrak-token", generateToken(userId));
  jar.set("ziyrak-workspace", fixture.businessId);
}
async function html(node: React.ReactNode) {
  const stream = await renderToReadableStream(node);
  return new Response(stream).text();
}
describe("P1 Administration actual cookie/membership SSR presentation", () => {
  it.each(["supervisor", "agent", "viewer"])(
    "%s sees explicit denial and no protected controls",
    async (role) => {
      select(actors.get(role)!);
      const output = await html(React.createElement(AdminPage));
      expect(output).toContain("Access denied");
      expect(output).not.toMatch(/Invite User|API Keys|Generate New Key|No users found/);
    }
  );
  it.each(["owner", "admin"])("%s retains legitimate Administration controls", async (role) => {
    select(actors.get(role)!);
    const output = await html(React.createElement(AdminPage));
    expect(output).toContain("Invite User");
    expect(output).toContain("API Keys");
    expect(output).not.toContain("Access denied");
  });
  it("restricted admin retains permitted reads/key tab without wider user delegation", async () => {
    const actor = await addMember(fixture.businessId, "admin", "presentation-restricted");
    await prisma.membership.update({
      where: { businessId_userId: { businessId: fixture.businessId, userId: actor.userId } },
      data: { scopeMode: "connections", customerProfileAccess: "none" },
    });
    select(actor.userId);
    const output = await html(React.createElement(AdminPage));
    expect(output).toContain("API Keys");
    expect(output).not.toContain("Invite User");
    expect(output).not.toContain("Access denied");
  });
  it.each(["supervisor", "agent", "viewer"])(
    "%s does not receive Administration navigation",
    async (role) => {
      select(actors.get(role)!);
      const output = await html(
        await DashboardLayout({ children: React.createElement("p", null, "Fixture page") })
      );
      expect(output).not.toContain('href="/admin"');
      expect(output).toContain('href="/conversations"');
    }
  );
  it("workspace admin retains Administration navigation", async () => {
    select(actors.get("admin")!);
    const output = await html(
      await DashboardLayout({ children: React.createElement("p", null, "Fixture page") })
    );
    expect(output).toContain('href="/admin"');
  });
  it("does not mount protected controls when the actual selected membership is removed", async () => {
    const actor = await addMember(fixture.businessId, "admin", "presentation-removed");
    select(actor.userId);
    await prisma.membership.delete({
      where: { businessId_userId: { businessId: fixture.businessId, userId: actor.userId } },
    });
    try {
      await expect(html(React.createElement(AdminPage))).rejects.toThrow(
        "FIXTURE_REDIRECT:/workspaces"
      );
    } finally {
      await prisma.user.delete({ where: { id: actor.userId } });
    }
  });
  it("does not mount protected controls after actual session revocation", async () => {
    select(actors.get("admin")!);
    await revokeToken(jar.get("ziyrak-token")!);
    await expect(html(React.createElement(AdminPage))).rejects.toThrow(
      "FIXTURE_REDIRECT:/workspaces"
    );
  });
});
