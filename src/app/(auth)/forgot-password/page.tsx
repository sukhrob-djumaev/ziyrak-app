"use client";
import { useState } from "react";
import Link from "next/link";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.status === 429) setError("Too many requests. Please try again later.");
      else setDone(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="bg-ziyrak-surface rounded-2xl shadow-lg border border-ziyrak-border p-8">
      <h1 className="text-2xl font-bold text-ziyrak-text">Reset your password</h1>
      {done ? (
        <p id="forgotDone" role="status" className="mt-4 text-sm text-ziyrak-text">
          If that address belongs to an account, a reset link is on its way. The link works once and expires in one hour.
        </p>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <label htmlFor="email" className="block text-sm font-medium text-ziyrak-text">Email address</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-lg border border-ziyrak-border bg-ziyrak-bg px-3.5 py-2.5 text-sm text-ziyrak-text focus:outline-none focus:ring-2 focus:ring-ziyrak-primary focus:border-transparent" />
          {error && <p role="alert" className="text-sm text-ziyrak-danger">{error}</p>}
          <button id="sendReset" type="submit" disabled={busy} className="w-full rounded-lg bg-ziyrak-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-ziyrak-primary-dark disabled:opacity-60">Send reset link</button>
        </form>
      )}
      <p className="mt-6 text-center text-sm"><Link href="/login" className="font-medium text-ziyrak-primary hover:underline">Back to sign in</Link></p>
    </div>
  );
}
