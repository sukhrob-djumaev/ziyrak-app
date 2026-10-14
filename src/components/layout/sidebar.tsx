"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  BookOpen,
  Users,
  Contact,
  MessageSquare,
  Settings,
  Radio,
  Ticket,
  BarChart3,
  ScrollText,
  Timer,
  Zap,
  Workflow,
  Clock,
  Shield,
  FileCode,
  Webhook,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useLiveRefresh } from "@/lib/hooks/use-live-refresh";

interface NavSection {
  title?: string;
  items: { name: string; href: string; icon: React.ElementType }[];
}

const sections: NavSection[] = [
  {
    items: [
      { name: "Dashboard", href: "/", icon: LayoutDashboard },
      { name: "Conversations", href: "/conversations", icon: MessageSquare },
      { name: "Customers", href: "/customers", icon: Contact },
      { name: "Tickets", href: "/tickets", icon: Ticket },
    ],
  },
  {
    title: "Knowledge",
    items: [
      { name: "Knowledge Base", href: "/knowledge", icon: BookOpen },
      { name: "Canned Responses", href: "/canned-responses", icon: Zap },
      { name: "Automation", href: "/automation", icon: Workflow },
      { name: "Business Hours", href: "/business-hours", icon: Clock },
    ],
  },
  {
    title: "Team",
    items: [
      { name: "Team", href: "/team", icon: Users },
      { name: "SLA Rules", href: "/sla", icon: Timer },
      { name: "Approvals", href: "/approvals", icon: ShieldCheck },
    ],
  },
  {
    title: "Channels",
    items: [
      { name: "Channels", href: "/channels", icon: Radio },
      { name: "Webhooks", href: "/webhooks", icon: Webhook },
    ],
  },
  {
    title: "Insights",
    items: [
      { name: "Analytics", href: "/analytics", icon: BarChart3 },
      { name: "Activity Log", href: "/activity", icon: ScrollText },
    ],
  },
  {
    title: "System",
    items: [
      { name: "Administration", href: "/admin", icon: Shield },
      { name: "API Docs", href: "/api-docs", icon: FileCode },
      { name: "Settings", href: "/settings", icon: Settings },
      { name: "Switch workspace", href: "/workspaces", icon: Users },
    ],
  },
];

const APPROVALS_HREF = "/approvals";
const APPROVALS_POLL_MS = 30_000;

/**
 * How many AI actions are waiting for a human decision, for the sidebar badge.
 * `null` means the caller may not review approvals (403) or the count is
 * unavailable, in which case the Approvals link is hidden / shows no badge.
 */
function usePendingApprovals(): number | null {
  const [count, setCount] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/actions?status=pending_approval&limit=1");
      if (!res.ok) {
        setCount(null);
        return;
      }
      const body = await res.json();
      setCount(typeof body?.pagination?.total === "number" ? body.pagination.total : null);
    } catch {
      // Transient failure: keep the last known count.
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useLiveRefresh(refresh, { intervalMs: APPROVALS_POLL_MS });

  return count;
}

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const pendingApprovals = usePendingApprovals();

  return (
    <aside
      className={cn(
        "flex flex-col bg-owly-sidebar text-white transition-all duration-300",
        collapsed ? "w-16" : "w-60"
      )}
    >
      <div className="flex items-center gap-3 px-4 py-4 border-b border-white/10">
        <Image
          src="/owly.png"
          alt="Owly"
          width={32}
          height={32}
          className="rounded-lg flex-shrink-0"
        />
        {!collapsed && (
          <div className="overflow-hidden">
            <h1 className="text-base font-bold tracking-tight">Owly</h1>
            <p className="text-[10px] text-white/50">AI Customer Support</p>
          </div>
        )}
      </div>

      <nav className="flex-1 px-2 py-3 overflow-y-auto space-y-3">
        {sections.map((section, si) => (
          <div key={si}>
            {section.title && !collapsed && (
              <p className="px-3 mb-1 text-[10px] uppercase tracking-wider text-white/40 font-medium">
                {section.title}
              </p>
            )}
            {collapsed && si > 0 && <div className="mx-3 mb-2 border-t border-white/10" />}
            <div className="space-y-0.5">
              {section.items
                // Only roles allowed to review approvals get the link (the count request 403s for others).
                .filter((item) => item.href !== APPROVALS_HREF || pendingApprovals !== null)
                .map((item) => {
                  const isActive =
                    pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));

                  return (
                    <Link
                      key={item.name}
                      href={item.href}
                      className={cn(
                        "relative flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors",
                        isActive
                          ? "bg-owly-sidebar-active text-white"
                          : "text-white/65 hover:bg-owly-sidebar-hover hover:text-white"
                      )}
                      title={collapsed ? item.name : undefined}
                    >
                      <item.icon className="h-4 w-4 flex-shrink-0" />
                      {!collapsed && <span>{item.name}</span>}
                      {item.href === APPROVALS_HREF && pendingApprovals ? (
                        <span
                          data-testid="approvals-badge"
                          className={cn(
                            "ml-auto rounded-full bg-owly-warning px-1.5 text-[10px] font-semibold leading-4 text-white",
                            collapsed && "absolute -top-1 -right-1 ml-0"
                          )}
                        >
                          {pendingApprovals > 99 ? "99+" : pendingApprovals}
                        </span>
                      ) : null}
                    </Link>
                  );
                })}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-2 py-2 border-t border-white/10">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center justify-center w-full py-1.5 rounded-md text-white/40 hover:text-white hover:bg-owly-sidebar-hover transition-colors"
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>
    </aside>
  );
}
