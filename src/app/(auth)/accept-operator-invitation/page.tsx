"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

const FIELD =
  "w-full rounded-lg border border-owly-border bg-owly-bg px-3.5 py-2.5 text-sm text-owly-text focus:outline-none focus:ring-2 focus:ring-owly-primary focus:border-transparent";
const BTN = "w-full rounded-lg bg-owly-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-owly-primary-dark disabled:opacity-60";

function Accept() {
  const token = useSearchParams().get("token") ?? "";
  const [email, setEmail] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [done, setDone] = useState(false);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/operator-invitation/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (!active) return;
        if (res.ok) setEmail((await res.json()).email);
        else setInvalid(true);
      })
      .catch(() => active && setInvalid(true));
    return () => {
      active = false;
    };
  }, [token]);

  async function accept(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/operator-invitation/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name, username, password }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) return setDone(true);
      setError(body?.error ?? "That did not work. Try again.");
    } catch {
      setError("That did not work. Try again.");
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  if (invalid)
    return (
      <p id="operatorInviteInvalid" role="alert" className="mt-4 text-sm text-owly-danger">
        This invitation is invalid or has expired. Ask the super admin to send a new one.
      </p>
    );
  if (done)
    return (
      <p id="operatorInviteDone" role="status" className="mt-4 text-sm text-owly-text">
        Your operator account is ready.{" "}
        <Link href="/login" className="font-medium text-owly-primary hover:underline">
          Sign in
        </Link>
      </p>
    );
  if (!email) return <p role="status" className="mt-4 text-sm text-owly-text-light">Loading…</p>;
  return (
    <form onSubmit={accept} className="mt-6 space-y-4">
      <p id="operatorInviteSummary" className="text-sm text-owly-text">
        You are invited to join the platform operations team with the address <strong>{email}</strong>.
      </p>
      <label htmlFor="operatorInviteName" className="block text-sm font-medium text-owly-text">Your name</label>
      <input id="operatorInviteName" className={FIELD} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
      <label htmlFor="operatorInviteUsername" className="block text-sm font-medium text-owly-text">Choose a username</label>
      <input id="operatorInviteUsername" className={FIELD} required minLength={3} maxLength={100} pattern="[a-zA-Z0-9_.\-]+" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
      <label htmlFor="operatorInvitePassword" className="block text-sm font-medium text-owly-text">Choose a password (at least 12 characters)</label>
      <input id="operatorInvitePassword" type="password" className={FIELD} required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      {error && <p role="alert" className="text-sm text-owly-danger">{error}</p>}
      <button id="acceptOperatorInvitation" type="submit" disabled={busy} className={BTN}>
        Create operator account
      </button>
    </form>
  );
}

export default function AcceptOperatorInvitationPage() {
  return (
    <div className="bg-owly-surface rounded-2xl shadow-lg border border-owly-border p-8">
      <h1 className="text-2xl font-bold text-owly-text">Join the platform team</h1>
      <Suspense fallback={null}>
        <Accept />
      </Suspense>
    </div>
  );
}
