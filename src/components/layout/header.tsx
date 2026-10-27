"use client";

import { Sun, Moon, LogOut, User, Settings, Users, Menu } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useTheme } from "@/lib/hooks/use-theme";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { useCan } from "@/components/layout/permissions";
import { useMobileNav } from "@/components/layout/mobile-nav";

interface Me {
  user: { id: string; name: string; username: string };
  role: string | null;
  business: { id: string; name: string };
}

// Fetched on every header mount, never cached across mounts: a different person
// signing in on the same tab must not briefly see the previous identity.
function loadMe(): Promise<Me | null> {
  return fetch("/api/me")
    .then((res) => (res.ok ? (res.json() as Promise<Me>) : null))
    .catch(() => null);
}

function initialOf(me: Me | null): string {
  const source = me?.user.name?.trim() || me?.user.username || "";
  return source ? source.charAt(0).toUpperCase() : "";
}

interface HeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

export function Header({ title, description, actions }: HeaderProps) {
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const router = useRouter();
  const { toast } = useToast();
  const canReadSettings = useCan("settings:read");
  const { open: navOpen, setOpen: setNavOpen } = useMobileNav();
  const [me, setMe] = useState<Me | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setUserMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadMe().then((value) => {
      if (!cancelled) setMe(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = async () => {
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      });
      // The browser is signed out either way; if the server could not end the session, say so.
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast({
          type: "warning",
          title: res.status === 429 ? "Signed out here, try again shortly" : "Signed out of this browser only",
          description: body?.error?.message ?? body?.error ?? "The session could not be ended on the server. Please sign out again.",
        });
      }
    } catch {
      toast({ type: "warning", title: "Signed out of this browser only", description: "Could not reach the server to end the session." });
    }
    router.push("/login");
  };

  return (
    <header className="flex items-center justify-between gap-3 px-4 md:px-6 py-3 md:py-4 bg-ziyrak-surface border-b border-ziyrak-border transition-theme">
      <button
        onClick={() => setNavOpen(true)}
        aria-label="Open menu"
        aria-expanded={navOpen}
        className="md:hidden p-2 -ml-2 text-ziyrak-text-light hover:text-ziyrak-text hover:bg-ziyrak-primary-50 rounded-lg"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>
      <div className="animate-fade-in min-w-0 flex-1">
        <h1 className="text-lg md:text-xl font-semibold text-ziyrak-text truncate">{title}</h1>
        {description && (
          <p className="text-sm text-ziyrak-text-light mt-0.5">{description}</p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={toggleTheme}
          className="p-2 text-ziyrak-text-light hover:text-ziyrak-text hover:bg-ziyrak-primary-50 rounded-lg transition-colors"
          title={theme === "light" ? "Dark mode" : "Light mode"}
          aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
        >
          {theme === "light" ? (
            <Moon className="h-5 w-5" />
          ) : (
            <Sun className="h-5 w-5" />
          )}
        </button>

        {actions}

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
            aria-label={me ? `Account menu for ${me.user.name || me.user.username}` : "Account menu"}
            title={me ? `${me.user.name || me.user.username} · ${me.business.name}` : undefined}
            className="flex items-center justify-center w-8 h-8 rounded-full bg-ziyrak-primary text-white text-sm font-medium hover:bg-ziyrak-primary-dark transition-colors"
          >
            {initialOf(me) || <User className="h-4 w-4" />}
          </button>

          {userMenuOpen && (
            <div className="absolute right-0 mt-2 w-56 bg-ziyrak-surface border border-ziyrak-border rounded-lg shadow-lg py-1 z-50 animate-scale-in transition-theme">
              {me && (
                <div className="px-4 py-2 border-b border-ziyrak-border" data-testid="account-summary">
                  <p className="text-sm font-medium text-ziyrak-text truncate">{me.user.name || me.user.username}</p>
                  <p className="text-xs text-ziyrak-text-light truncate">
                    <span className="capitalize">{me.role ?? "member"}</span> · {me.business.name}
                  </p>
                </div>
              )}
              <button
                onClick={() => {
                  setUserMenuOpen(false);
                  router.push("/account");
                }}
                className="flex items-center gap-2 w-full px-4 py-2 text-sm text-ziyrak-text hover:bg-ziyrak-primary-50 transition-colors"
              >
                <User className="h-4 w-4" />
                My account
              </button>
              {canReadSettings && (
                <button
                  onClick={() => {
                    setUserMenuOpen(false);
                    router.push("/settings");
                  }}
                  className="flex items-center gap-2 w-full px-4 py-2 text-sm text-ziyrak-text hover:bg-ziyrak-primary-50 transition-colors"
                >
                  <Settings className="h-4 w-4" />
                  Workspace settings
                </button>
              )}
              <button
                onClick={() => {
                  setUserMenuOpen(false);
                  router.push("/workspaces");
                }}
                className="flex items-center gap-2 w-full px-4 py-2 text-sm text-ziyrak-text hover:bg-ziyrak-primary-50 transition-colors"
              >
                <Users className="h-4 w-4" />
                Switch workspace
              </button>
              <div className="border-t border-ziyrak-border my-1" />
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 w-full px-4 py-2 text-sm text-ziyrak-danger hover:bg-red-50 transition-colors"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
