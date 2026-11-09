"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Begun = { secret: string; otpauthUri: string };
const field = "w-full rounded border border-ziyrak-border bg-ziyrak-bg p-2";
const button = "rounded bg-ziyrak-primary-fill px-4 py-2 text-white disabled:opacity-50";

export default function PlatformMfaPage() {
  const router = useRouter();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [ownerProof, setOwnerProof] = useState("");
  const [begun, setBegun] = useState<Begun | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/mfa", { cache: "no-store" })
      .then(async (response) => {
        if (!active) return;
        if (response.status === 401) return router.replace("/login");
        if (response.status === 404) return setUnavailable(true);
        if (!response.ok) throw new Error("Could not load two-step sign-in status.");
        setEnabled(Boolean((await response.json()).enabled));
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [router]);

  async function post(payload: object) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/mfa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.error === "string" ? body.error : "The request was not accepted.");
        return null;
      }
      return body;
    } catch {
      setError("An unexpected error occurred. Please try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function enroll() {
    const body = await post({
      action: "enroll",
      ...(ownerProof.trim() ? { ownerProof: ownerProof.trim() } : { setupCode: setupCode.trim() }),
    });
    if (body) {
      setBegun(body as Begun);
      setSetupCode("");
      setOwnerProof("");
    }
  }

  async function confirm() {
    const body = await post({ action: "confirm", code });
    if (body) {
      setBegun(null);
      setCode("");
      setEnabled(true);
      setRecoveryCodes((body as { recoveryCodes: string[] }).recoveryCodes);
    }
  }

  return (
    <section className="rounded-2xl border border-ziyrak-border bg-ziyrak-surface p-6 shadow-lg">
      <h1 className="text-2xl font-bold">Two-step sign-in</h1>
      {unavailable ? (
        <p role="alert" className="mt-4">
          Two-step sign-in is only available for platform accounts.
        </p>
      ) : enabled === null ? (
        <p role="status" className="mt-4">
          {error || "Loading…"}
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          {recoveryCodes && (
            <div role="status" className="space-y-2">
              <h2 className="text-xl font-semibold">Save your recovery codes</h2>
              <p>Each code works once if you lose your authenticator. They are shown only now.</p>
              <ul id="recoveryCodes" className="font-mono text-sm space-y-1">
                {recoveryCodes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          {enabled && !recoveryCodes && (
            <p id="mfaEnabled" role="status">
              Two-step sign-in is on for this account. To change it, ask another super admin to reset it.
            </p>
          )}
          {!enabled && !begun && (
            <div className="space-y-3">
              <p>
                Enter the one-time setup code a different super admin gave you. The first super admin can use the
                platform owner proof instead.
              </p>
              <label className="block" htmlFor="setupCode">
                Setup code
              </label>
              <input id="setupCode" className={field} autoComplete="off" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} />
              <label className="block" htmlFor="ownerProof">
                Platform owner proof (first super admin only)
              </label>
              <input id="ownerProof" type="password" className={field} autoComplete="off" value={ownerProof} onChange={(e) => setOwnerProof(e.target.value)} />
              <button id="startEnrollment" type="button" className={button} disabled={busy || !(setupCode.trim() || ownerProof.trim())} onClick={enroll}>
                Start setup
              </button>
            </div>
          )}
          {!enabled && begun && (
            <div className="space-y-3">
              <p>
                Add this key to your authenticator app (account type: time-based), then enter the 6-digit code it shows.
              </p>
              <p>
                Key: <code id="mfaSecret" className="break-all">{begun.secret}</code>
              </p>
              <p className="text-xs break-all">
                Or open: <a className="text-ziyrak-primary underline" href={begun.otpauthUri}>{begun.otpauthUri}</a>
              </p>
              <label className="block" htmlFor="confirmCode">
                Authenticator code
              </label>
              <input id="confirmCode" className={field} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
              <button id="confirmEnrollment" type="button" className={button} disabled={busy || !code.trim()} onClick={confirm}>
                Turn on two-step sign-in
              </button>
            </div>
          )}
          {error && (
            <p role="alert" className="text-ziyrak-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
