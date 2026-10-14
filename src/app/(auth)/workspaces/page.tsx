"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
type Workspace = { id: string; name: string; role: string };
export default function WorkspacesPage() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    fetch("/api/workspaces")
      .then(async (response) => {
        if (response.status === 401) {
          router.replace("/login");
          return;
        }
        if (!response.ok) throw new Error("Could not load your workspaces. Please try again.");
        const body = await response.json();
        if (active) setWorkspaces(body.workspaces);
      })
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [router]);
  async function choose(workspaceId: string) {
    setPending(workspaceId);
    setError("");
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (!response.ok) throw new Error("This workspace is unavailable. Refresh and try again.");
      // A document navigation resets subscriptions and cached tenant views.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Workspace changes require a full document reload to discard old tenant subscriptions/views.
      window.location.assign("/");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not select the workspace");
      setPending(null);
    }
  }
  return (
    <section className="rounded-2xl border border-owly-border bg-owly-surface p-8 shadow-lg">
      <h1 className="text-2xl font-bold text-owly-text">Choose a workspace</h1>
      <p className="mt-2 text-sm text-owly-text-light">Open the workspace you want to work in.</p>
      {loading ? (
        <p className="mt-6" role="status">
          Loading workspaces…
        </p>
      ) : (
        <div className="mt-6 space-y-3">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              disabled={pending !== null}
              onClick={() => choose(workspace.id)}
              className="w-full rounded-lg border border-owly-border p-4 text-left hover:bg-owly-bg disabled:opacity-60"
            >
              <span className="block font-semibold">{workspace.name}</span>
              <span className="text-sm capitalize text-owly-text-light">{workspace.role}</span>
            </button>
          ))}
          {!workspaces.length && !error && (
            <p>No workspace access is available. Ask your workspace owner to restore access.</p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-owly-danger">
          {error}
        </p>
      )}
      <Link href="/login" className="mt-6 inline-block text-sm text-owly-primary">
        Back to sign in
      </Link>
    </section>
  );
}
