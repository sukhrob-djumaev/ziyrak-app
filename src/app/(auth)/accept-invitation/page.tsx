"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

interface Preview {
  email: string;
  role: string;
  workspaceName: string;
  existingAccount: boolean;
}
const FIELD =
  "w-full rounded-lg border border-ziyrak-border bg-ziyrak-bg px-3.5 py-2.5 text-sm text-ziyrak-text focus:outline-none focus:ring-2 focus:ring-ziyrak-primary focus:border-transparent";
const BTN = "w-full rounded-lg bg-ziyrak-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-ziyrak-primary-dark disabled:opacity-60";

function Accept() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [preview, setPreview] = useState<Preview | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [signInNeeded, setSignInNeeded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/invitation/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (!active) return;
        if (res.ok) setPreview(await res.json());
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
    setSignInNeeded(false);
    try {
      const res = await fetch("/api/auth/invitation/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preview?.existingAccount ? { token } : { token, name, username, password }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) return router.replace("/");
      if (body?.code === "SIGN_IN_REQUIRED") setSignInNeeded(true);
      setError(body?.error ?? "That did not work. Try again.");
    } catch {
      setError("That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (invalid)
    return (
      <p id="inviteInvalid" role="alert" className="mt-4 text-sm text-ziyrak-danger">
        This invitation is invalid or has expired. Ask the person who invited you to send a new one.
      </p>
    );
  if (!preview) return <p role="status" className="mt-4 text-sm text-ziyrak-text-light">Loading…</p>;
  return (
    <form onSubmit={accept} className="mt-6 space-y-4">
      <p id="inviteSummary" className="text-sm text-ziyrak-text">
        You are invited to join <strong>{preview.workspaceName}</strong> as <strong>{preview.role}</strong> with the address{" "}
        <strong>{preview.email}</strong>.
      </p>
      {preview.existingAccount ? (
        <p className="text-sm text-ziyrak-text-light">
          This address already has an account. Sign in to that account, then return to this link to accept.
        </p>
      ) : (
        <>
          <label htmlFor="inviteName" className="block text-sm font-medium text-ziyrak-text">Your name</label>
          <input id="inviteName" className={FIELD} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          <label htmlFor="inviteUsername" className="block text-sm font-medium text-ziyrak-text">Choose a username</label>
          <input id="inviteUsername" className={FIELD} required value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          <label htmlFor="invitePassword" className="block text-sm font-medium text-ziyrak-text">Choose a password</label>
          <input id="invitePassword" type="password" className={FIELD} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </>
      )}
      {error && <p role="alert" className="text-sm text-ziyrak-danger">{error}</p>}
      {signInNeeded && (
        <p className="text-sm">
          <Link id="inviteSignIn" href="/login" className="font-medium text-ziyrak-primary hover:underline">Sign in</Link>
        </p>
      )}
      <button id="acceptInvitation" type="submit" disabled={busy} className={BTN}>
        Accept invitation
      </button>
    </form>
  );
}

export default function AcceptInvitationPage() {
  return (
    <div className="bg-ziyrak-surface rounded-2xl shadow-lg border border-ziyrak-border p-8">
      <h1 className="text-2xl font-bold text-ziyrak-text">Join a workspace</h1>
      <Suspense fallback={null}>
        <Accept />
      </Suspense>
    </div>
  );
}
