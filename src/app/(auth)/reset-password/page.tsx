"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

function ResetForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (password !== confirm) return setError("The passwords do not match.");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) setDone(true);
      else setError((await res.json().catch(() => null))?.error ?? "This link is invalid or has expired.");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  if (done)
    return (
      <p id="resetDone" role="status" className="mt-4 text-sm text-ziyrak-text">
        Your password was changed and other sessions were signed out.{" "}
        <Link href="/login" className="font-medium text-ziyrak-primary hover:underline">Sign in</Link>
      </p>
    );
  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <label htmlFor="newPassword" className="block text-sm font-medium text-ziyrak-text">New password</label>
      <input id="newPassword" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-lg border border-ziyrak-border bg-ziyrak-bg px-3.5 py-2.5 text-sm text-ziyrak-text focus:outline-none focus:ring-2 focus:ring-ziyrak-primary focus:border-transparent" />
      <label htmlFor="confirmPassword" className="block text-sm font-medium text-ziyrak-text">Confirm new password</label>
      <input id="confirmPassword" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} className="w-full rounded-lg border border-ziyrak-border bg-ziyrak-bg px-3.5 py-2.5 text-sm text-ziyrak-text focus:outline-none focus:ring-2 focus:ring-ziyrak-primary focus:border-transparent" />
      {error && <p role="alert" className="text-sm text-ziyrak-danger">{error}</p>}
      <button id="setPassword" type="submit" disabled={busy || !token} className="w-full rounded-lg bg-ziyrak-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-ziyrak-primary-dark disabled:opacity-60">Set new password</button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="bg-ziyrak-surface rounded-2xl shadow-lg border border-ziyrak-border p-8">
      <h1 className="text-2xl font-bold text-ziyrak-text">Choose a new password</h1>
      <Suspense fallback={null}><ResetForm /></Suspense>
    </div>
  );
}
