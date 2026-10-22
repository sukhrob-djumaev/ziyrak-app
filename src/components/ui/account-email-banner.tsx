"use client";

import { useEffect, useState } from "react";

/** PLAN.md P3 — asks a person without a confirmed email to add and confirm one (existing username accounts adopt softly). */
export function AccountEmailBanner() {
  const [state, setState] = useState<{ email: string | null; verified: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/email", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => body && setState(body))
      .catch(() => undefined);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/auth/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        setMessage(body?.message ?? "A confirmation link is on its way.");
        setPassword("");
      } else setError(body?.error ?? "That did not work. Try again.");
    } catch {
      setError("That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!state || state.verified) return null;
  return (
    <div id="accountEmailBanner" className="bg-owly-surface rounded-xl border border-owly-border px-5 py-4 text-sm text-owly-text">
      <p>
        {state.email
          ? `Confirm ${state.email} to secure your account and enable password recovery.`
          : "Add and confirm an email address to secure your account and enable password recovery."}{" "}
        <button id="accountEmailOpen" type="button" onClick={() => setOpen((v) => !v)} className="font-medium text-owly-primary hover:underline">
          {open ? "Close" : state.email ? "Use a different address" : "Add email"}
        </button>
      </p>
      {open && (
        <form onSubmit={submit} className="mt-3 grid gap-2 sm:max-w-md">
          <label htmlFor="accountEmail" className="text-xs font-medium">Email address</label>
          <input id="accountEmail" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-lg border border-owly-border bg-owly-bg px-3 py-2" />
          <label htmlFor="accountEmailPassword" className="text-xs font-medium">Current password</label>
          <input id="accountEmailPassword" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="rounded-lg border border-owly-border bg-owly-bg px-3 py-2" autoComplete="current-password" />
          <button id="accountEmailSubmit" type="submit" disabled={busy} className="rounded-lg bg-owly-primary px-3 py-2 font-semibold text-white disabled:opacity-60">
            Send confirmation link
          </button>
        </form>
      )}
      {message && <p role="status" className="mt-2">{message}</p>}
      {error && <p role="alert" className="mt-2 text-owly-danger">{error}</p>}
    </div>
  );
}
