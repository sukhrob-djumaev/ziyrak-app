"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Entry = {
  account: { id: string; username: string; name: string };
  role: "super_admin" | "operator" | null;
  generation: number;
  bootstrapAvailable: boolean;
  recoveryAvailable: boolean;
};
export default function PlatformEnrollmentPage() {
  const router = useRouter();
  const [entry, setEntry] = useState<Entry | null>(null);
  const [action, setAction] = useState("bootstrap");
  const [proof, setProof] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function load() {
    const response = await fetch("/api/platform/enrollment", { cache: "no-store" });
    if (response.status === 401) {
      router.replace("/login");
      return;
    }
    if (!response.ok) throw new Error("Could not load platform enrollment. Try again.");
    const body: Entry = await response.json();
    setEntry(body);
    setAction(body.bootstrapAvailable ? "bootstrap" : "recovery");
  }
  useEffect(() => {
    let active = true;
    fetch("/api/platform/enrollment", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          router.replace("/login");
          return;
        }
        if (!response.ok) throw new Error("Could not load platform enrollment. Try again.");
        const body: Entry = await response.json();
        if (active) {
          setEntry(body);
          setAction(body.bootstrapAvailable ? "bootstrap" : "recovery");
        }
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [router]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!entry || !confirmed || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/platform/enrollment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          targetUserId: entry.account.id,
          proof,
          reason,
          ...(action === "recovery" ? { expectedGeneration: entry.generation } : {}),
        }),
      });
      if (response.status === 401) {
        router.replace("/login");
        return;
      }
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error?.message || "Platform authority could not be updated");
      await load();
      setReason("");
      setMessage("Platform authority updated.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Platform authority could not be updated");
    } finally {
      setProof("");
      setConfirmed(false);
      setBusy(false);
    }
  }
  const available = entry && (entry.bootstrapAvailable || entry.recoveryAvailable);
  return (
    <section className="rounded-2xl border border-owly-border bg-owly-surface p-8 shadow-lg">
      <h1 className="text-2xl font-bold">Platform enrollment</h1>
      {entry ? (
        <>
          <p className="mt-3">
            Signed in as {entry.account.name || entry.account.username} ({entry.account.username})
          </p>
          <p className="mt-2">
            Platform role:{" "}
            {entry.role === "super_admin"
              ? "Super admin"
              : entry.role === "operator"
                ? "Operator"
                : "None"}
          </p>
          <p>Authority generation: {entry.generation}</p>
          {available ? (
            <form onSubmit={submit} className="mt-6 space-y-4">
              <label className="block" htmlFor="enrollmentAction">
                Action
              </label>
              <select
                id="enrollmentAction"
                value={action}
                onChange={(event) => setAction(event.target.value)}
                disabled={busy}
                className="w-full rounded border p-2"
              >
                {entry.bootstrapAvailable && <option value="bootstrap">Enroll this account</option>}
                {entry.recoveryAvailable && (
                  <option value="recovery">Recover platform authority</option>
                )}
              </select>
              <label className="block" htmlFor="ownerProof">
                {action === "recovery" ? "Recovery owner proof" : "Enrollment owner proof"}
              </label>
              <input
                id="ownerProof"
                type="password"
                autoComplete="off"
                value={proof}
                onChange={(event) => setProof(event.target.value)}
                required
                maxLength={4096}
                disabled={busy}
                className="w-full rounded border p-2"
              />
              <label className="block" htmlFor="enrollmentReason">
                Reason
              </label>
              <textarea
                id="enrollmentReason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required
                maxLength={1000}
                disabled={busy}
                className="w-full rounded border p-2"
              />
              <label className="flex gap-2">
                <input
                  id="confirmAccount"
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  disabled={busy}
                  required
                />
                I select my signed-in account for this change.
              </label>
              <button
                type="submit"
                disabled={busy || !confirmed || !proof || !reason.trim()}
                className="rounded bg-owly-primary px-4 py-2 text-white disabled:opacity-50"
              >
                {busy
                  ? "Updating…"
                  : action === "recovery"
                    ? "Recover platform authority"
                    : "Enroll this account"}
              </button>
            </form>
          ) : (
            <p className="mt-6">Platform enrollment is unavailable. Contact the platform owner.</p>
          )}
        </>
      ) : (
        !error && (
          <p role="status" className="mt-6">
            Loading enrollment…
          </p>
        )
      )}
      {error && (
        <p role="alert" className="mt-4 text-owly-danger">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mt-4">
          {message}
        </p>
      )}
      <Link href="/workspaces" className="mt-6 inline-block text-owly-primary">
        Choose a workspace
      </Link>
    </section>
  );
}
