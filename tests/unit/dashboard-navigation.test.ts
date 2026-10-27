import { describe, it, expect } from "vitest";
import { PERMISSIONS, ROLES, hasPermission, type Permission } from "@/lib/rbac/rbac";
import { permissionsForRole, permissionsForContext } from "@/lib/rbac/view";
import type { TenantContext } from "@/lib/tenancy/context";
import { NAV_SECTIONS, visibleNavigation, permissionForPath } from "@/lib/navigation/dashboard-nav";

/** L3.1 / D01: what the sidebar shows is derived from the same permission table the APIs enforce. */
const names = (role: string) => visibleNavigation(permissionsForRole(role)).flatMap((s) => s.items.map((i) => i.name));

describe("permission view", () => {
  it.each(ROLES)("lists exactly the permissions the %s role holds", (role) => {
    const view = permissionsForRole(role);
    for (const p of Object.keys(PERMISSIONS) as Permission[]) expect(view.includes(p), `${role} ${p}`).toBe(hasPermission(role, p));
  });
  it("gives an unknown or missing role nothing", () => {
    expect(permissionsForRole("")).toEqual([]);
    expect(permissionsForRole("superuser")).toEqual([]);
  });
});

describe("dashboard navigation", () => {
  it("never shows a link whose list API the role cannot read", () => {
    for (const role of ROLES) {
      const view = new Set(permissionsForRole(role));
      for (const s of NAV_SECTIONS) for (const i of s.items) {
        if (i.requires && !view.has(i.requires)) expect(names(role), `${role} sees ${i.name}`).not.toContain(i.name);
      }
    }
  });
  it("viewers do not see Channels, Webhooks, Activity Log, Canned Responses, Approvals, Administration or Settings", () => {
    const v = names("viewer");
    for (const hidden of ["Channels", "Webhooks", "Activity Log", "Canned Responses", "Approvals", "People & Access", "Settings"]) expect(v, hidden).not.toContain(hidden);
    for (const shown of ["Dashboard", "Conversations", "Customers", "Tickets", "Knowledge Base", "Analytics", "Switch workspace"]) expect(v, shown).toContain(shown);
  });
  it("agents see Canned Responses but not Channels, Webhooks or Activity Log", () => {
    const a = names("agent");
    expect(a).toContain("Canned Responses");
    for (const hidden of ["Channels", "Webhooks", "Activity Log", "Approvals"]) expect(a, hidden).not.toContain(hidden);
  });
  it("supervisors see Channels, Webhooks, Activity Log and Approvals but not Administration or Settings", () => {
    const s = names("supervisor");
    for (const shown of ["Channels", "Webhooks", "Activity Log", "Approvals"]) expect(s, shown).toContain(shown);
    for (const hidden of ["People & Access", "Settings"]) expect(s, hidden).not.toContain(hidden);
  });
  it("owners and admins see everything", () => {
    const all = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.name));
    expect(names("owner")).toEqual(all);
    expect(names("admin")).toEqual(all);
  });
  it("drops a section whose items are all hidden, and keeps the work-based group order", () => {
    const titles = (role: Parameters<typeof permissionsForRole>[0]) => visibleNavigation(permissionsForRole(role)).map((s) => s.title);
    expect(titles("owner")).toEqual([undefined, "Support", "Teach the assistant", "Set up", "Insights", "Workspace"]);
    expect(titles("viewer")).toContain("Insights"); // Analytics stays
    expect(visibleNavigation([]).map((s) => s.title)).toEqual([undefined, "Workspace"]); // no permissions: Dashboard, API Docs and Switch workspace remain
  });
});

describe("direct URL requirement", () => {
  it("maps every restricted nav path, and sub-paths, to its permission", () => {
    for (const s of NAV_SECTIONS) for (const i of s.items) {
      if (!i.requires) continue;
      expect(permissionForPath(i.href)?.permission, i.href).toBe(i.requires);
      expect(permissionForPath(i.href + "/anything")?.permission, i.href + "/x").toBe(i.requires);
    }
  });
  it("lets open pages through and does not confuse prefixes", () => {
    expect(permissionForPath("/")).toBeNull();
    expect(permissionForPath("/account")).toBeNull();
    expect(permissionForPath("/workspaces")).toBeNull();
    expect(permissionForPath("/api-docs")).toBeNull();
    expect(permissionForPath("/customers-export")).toBeNull();
  });
});

describe("permission view for a resolved context (channel scope)", () => {
  const ctx = (role: string, resourceScope: unknown) => ({ businessId: "b", role, actor: { kind: "user", userId: "u" }, dataConnection: "x", resourceScope }) as unknown as TenantContext;
  const wide = { kind: "workspace", customerProfileAccess: "write" };
  const scoped = { kind: "connections", connectionIds: ["c1"], customerProfileAccess: "none" };
  it("workspace-wide members keep Webhooks and Automation", () => {
    const v = permissionsForContext(ctx("admin", wide));
    expect(v).toContain("webhooks:read");
    expect(v).toContain("automation:read");
  });
  it("a member limited to specific channels does not get workspace-wide-only areas, but keeps the rest", () => {
    const v = permissionsForContext(ctx("admin", scoped));
    expect(v.some((p) => p.startsWith("webhooks:") || p.startsWith("automation:"))).toBe(false);
    expect(v).toContain("conversations:read");
    expect(v).toContain("channels:read");
  });
  it("a context with no usable scope hides scope-dependent areas instead of throwing", () => {
    expect(() => permissionsForContext(ctx("admin", undefined))).not.toThrow();
    expect(permissionsForContext(ctx("admin", undefined))).not.toContain("webhooks:read");
  });
});
