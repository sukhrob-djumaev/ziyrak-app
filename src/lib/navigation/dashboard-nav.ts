import type { Permission } from "@/lib/rbac/rbac";

export interface NavItem {
  name: string;
  href: string;
  /** Icon key resolved by the sidebar (kept out of this file so it stays plain data and testable). */
  icon: string;
  /** The read permission the page's own API needs. Absent = every signed-in member. */
  requires?: Permission;
}
export interface NavSection {
  title?: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { name: "Dashboard", href: "/", icon: "dashboard" },
      { name: "Conversations", href: "/conversations", icon: "conversations", requires: "conversations:read" },
      { name: "Customers", href: "/customers", icon: "customers", requires: "customers:read" },
      { name: "Tickets", href: "/tickets", icon: "tickets", requires: "tickets:read" },
    ],
  },
  {
    title: "Knowledge",
    items: [
      { name: "Knowledge Base", href: "/knowledge", icon: "knowledge", requires: "knowledge:read" },
      { name: "Canned Responses", href: "/canned-responses", icon: "canned", requires: "canned:read" },
      { name: "Automation", href: "/automation", icon: "automation", requires: "automation:read" },
      { name: "Business Hours", href: "/business-hours", icon: "hours", requires: "business-hours:read" },
    ],
  },
  {
    title: "Team",
    items: [
      { name: "Team Roster", href: "/team", icon: "team", requires: "team:read" },
      { name: "SLA Rules", href: "/sla", icon: "sla", requires: "sla:read" },
      { name: "Approvals", href: "/approvals", icon: "approvals", requires: "actions:read" },
    ],
  },
  {
    title: "Channels",
    items: [
      { name: "Channels", href: "/channels", icon: "channels", requires: "channels:read" },
      { name: "Webhooks", href: "/webhooks", icon: "webhooks", requires: "webhooks:read" },
    ],
  },
  {
    title: "Insights",
    items: [
      { name: "Analytics", href: "/analytics", icon: "analytics", requires: "analytics:read" },
      { name: "Activity Log", href: "/activity", icon: "activity", requires: "activity:read" },
    ],
  },
  {
    title: "System",
    items: [
      { name: "People & Access", href: "/admin", icon: "admin", requires: "admin:read" },
      { name: "API Docs", href: "/api-docs", icon: "docs" },
      { name: "Settings", href: "/settings", icon: "settings", requires: "settings:read" },
      { name: "Switch workspace", href: "/workspaces", icon: "switch" },
    ],
  },
];

/** Navigation limited to what the given permissions allow; sections left empty disappear. */
export function visibleNavigation(permissions: readonly Permission[]): NavSection[] {
  const held = new Set<Permission>(permissions);
  return NAV_SECTIONS.map((s) => ({ ...s, items: s.items.filter((i) => !i.requires || held.has(i.requires)) })).filter((s) => s.items.length > 0);
}

/** The permission a dashboard path needs (longest matching nav entry), or null when any member may open it. */
export function permissionForPath(pathname: string): { permission: Permission; name: string } | null {
  let best: NavItem | null = null;
  for (const s of NAV_SECTIONS)
    for (const i of s.items) {
      const match = i.href === "/" ? pathname === "/" : pathname === i.href || pathname.startsWith(i.href + "/");
      if (match && (!best || i.href.length > best.href.length)) best = i;
    }
  return best?.requires ? { permission: best.requires, name: best.name } : null;
}
