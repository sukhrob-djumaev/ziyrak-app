"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Header } from "@/components/layout/header";
import { useCan } from "@/components/layout/permissions";

interface Me {
  user: { id: string; name: string; username: string };
  role: string | null;
  business: { id: string; name: string };
}

/** Personal account view: who is signed in, in which workspace and role. Workspace administration lives under Settings. */
export default function AccountPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const canReadSettings = useCan("settings:read");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me")
      .then((r) => (r.ok ? (r.json() as Promise<Me>) : Promise.reject(new Error(String(r.status)))))
      .then((v) => {
        if (!cancelled) {
          setMe(v);
          setState("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <Header title="My account" description="Who you are signed in as, and in which workspace." />
      <div className="flex-1 overflow-y-auto p-6 max-w-2xl space-y-4">
        {state === "loading" && <p className="text-sm text-ziyrak-text-light">Loading your account…</p>}
        {state === "failed" && (
          <p role="alert" className="text-sm text-ziyrak-danger">
            Your account details could not be loaded. Reload the page, or sign in again if this continues.
          </p>
        )}
        {state === "ready" && me && (
          <dl className="grid grid-cols-[10rem_1fr] gap-y-3 text-sm" data-testid="account-details">
            <dt className="text-ziyrak-text-light">Name</dt>
            <dd className="text-ziyrak-text">{me.user.name || "—"}</dd>
            <dt className="text-ziyrak-text-light">Username</dt>
            <dd className="text-ziyrak-text">{me.user.username}</dd>
            <dt className="text-ziyrak-text-light">Workspace</dt>
            <dd className="text-ziyrak-text">{me.business.name}</dd>
            <dt className="text-ziyrak-text-light">Your role here</dt>
            <dd className="text-ziyrak-text capitalize">{me.role ?? "member"}</dd>
          </dl>
        )}
        <div className="flex gap-3 pt-2 text-sm">
          <Link href="/workspaces" className="text-ziyrak-primary hover:underline">
            Switch workspace
          </Link>
          {canReadSettings && (
            <Link href="/settings" className="text-ziyrak-primary hover:underline">
              Workspace settings
            </Link>
          )}
        </div>
        <p className="text-xs text-ziyrak-text-light">Your role is set by a workspace owner or admin and applies to this workspace only.</p>
      </div>
    </>
  );
}
