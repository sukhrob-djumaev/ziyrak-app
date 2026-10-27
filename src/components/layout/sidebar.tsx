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
import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveRefresh } from "@/lib/hooks/use-live-refresh";
import { usePermissions } from "@/components/layout/permissions";
import { useMobileNav } from "@/components/layout/mobile-nav";
import { visibleNavigation } from "@/lib/navigation/dashboard-nav";

const ICONS: Record<string, React.ElementType> = {
  dashboard: LayoutDashboard,
  conversations: MessageSquare,
  customers: Contact,
  tickets: Ticket,
  knowledge: BookOpen,
  canned: Zap,
  automation: Workflow,
  hours: Clock,
  team: Users,
  sla: Timer,
  approvals: ShieldCheck,
  channels: Radio,
  webhooks: Webhook,
  analytics: BarChart3,
  activity: ScrollText,
  admin: Shield,
  docs: FileCode,
  settings: Settings,
  switch: Users,
};

const APPROVALS_HREF = "/approvals";
const APPROVALS_POLL_MS = 30_000;

/**
 * How many AI actions are waiting for a human decision, for the sidebar badge.
 * `null` means the caller may not review approvals (403) or the count is
 * unavailable, in which case the Approvals link is hidden / shows no badge.
 */
function usePendingApprovals(enabled: boolean): number | null {
  const [count, setCount] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
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
  }, [enabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useLiveRefresh(refresh, { intervalMs: APPROVALS_POLL_MS });

  return count;
}

interface NavPanelProps {
  collapsed: boolean;
  pendingApprovals: number | null;
  onNavigate?: () => void;
  footer?: React.ReactNode;
}

function NavPanel({ collapsed, pendingApprovals, onNavigate, footer }: NavPanelProps) {
  const sections = visibleNavigation([...usePermissions()]);
  const pathname = usePathname();

  return (
    <>
      <div className="flex items-center gap-3 px-4 py-4 border-b border-white/10">
        <Image src="/ziyrak.png" alt="Ziyrak" width={32} height={32} className="rounded-lg flex-shrink-0" />
        {!collapsed && (
          <div className="overflow-hidden">
            <p className="text-base font-bold tracking-tight">Ziyrak</p>
            <p className="text-[10px] text-white/50">AI Customer Support</p>
          </div>
        )}
      </div>

      <nav aria-label="Main" className="flex-1 px-2 py-3 overflow-y-auto space-y-3">
        {sections.map((section, si) => (
          <div key={si}>
            {section.title && !collapsed && (
              <p className="px-3 mb-1 text-[10px] uppercase tracking-wider text-white/40 font-medium">{section.title}</p>
            )}
            {collapsed && si > 0 && <div className="mx-3 mb-2 border-t border-white/10" />}
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = ICONS[item.icon] ?? LayoutDashboard;
                const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                const badge = item.href === APPROVALS_HREF && pendingApprovals ? (pendingApprovals > 99 ? "99+" : String(pendingApprovals)) : null;

                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={isActive ? "page" : undefined}
                    aria-label={collapsed ? (badge ? `${item.name}, ${badge} waiting` : item.name) : undefined}
                    className={cn(
                      "relative flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
                      isActive ? "bg-ziyrak-sidebar-active text-white" : "text-white/65 hover:bg-ziyrak-sidebar-hover hover:text-white"
                    )}
                    title={collapsed ? item.name : undefined}
                  >
                    <Icon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                    {!collapsed && <span>{item.name}</span>}
                    {badge ? (
                      <span
                        data-testid="approvals-badge"
                        className={cn(
                          "ml-auto rounded-full bg-ziyrak-warning px-1.5 text-[10px] font-semibold leading-4 text-white",
                          collapsed && "absolute -top-1 -right-1 ml-0"
                        )}
                      >
                        {badge}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      {footer}
    </>
  );
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const pendingApprovals = usePendingApprovals(usePermissions().has("actions:read"));
  const { open, setOpen } = useMobileNav();
  const pathname = usePathname();
  const drawerRef = useRef<HTMLDivElement>(null);

  // A new page closes the drawer; Escape closes it too, and focus moves into it while it is open.
  useEffect(() => setOpen(false), [pathname, setOpen]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return setOpen(false);
      if (e.key !== "Tab") return;
      // Keep Tab inside the open menu (it is modal).
      const items = [...(drawerRef.current?.querySelectorAll<HTMLElement>("a,button") ?? [])];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    drawerRef.current?.querySelector<HTMLElement>("a,button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.getElementById("open-menu")?.focus(); // focus goes back to the button that opened it
    };
  }, [open, setOpen]);

  return (
    <>
      <aside
        className={cn(
          "hidden md:flex flex-col bg-ziyrak-sidebar text-white transition-all duration-300",
          collapsed ? "w-16" : "w-60"
        )}
      >
        <NavPanel
          collapsed={collapsed}
          pendingApprovals={pendingApprovals}
          footer={
            <div className="px-2 py-2 border-t border-white/10">
              <button
                onClick={() => setCollapsed(!collapsed)}
                aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
                aria-expanded={!collapsed}
                className="flex items-center justify-center w-full py-1.5 rounded-md text-white/60 hover:text-white hover:bg-ziyrak-sidebar-hover transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                {collapsed ? <ChevronRight className="h-4 w-4" aria-hidden="true" /> : <ChevronLeft className="h-4 w-4" aria-hidden="true" />}
              </button>
            </div>
          }
        />
      </aside>

      {open && (
        <div className="md:hidden fixed inset-0 z-50 flex" data-testid="mobile-nav">
          <div ref={drawerRef} role="dialog" aria-modal="true" aria-label="Navigation menu" className="flex flex-col w-64 max-w-[85vw] bg-ziyrak-sidebar text-white">
            <NavPanel collapsed={false} pendingApprovals={pendingApprovals} onNavigate={() => setOpen(false)} />
          </div>
          <button aria-label="Close menu" className="flex-1 bg-black/50" onClick={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}
