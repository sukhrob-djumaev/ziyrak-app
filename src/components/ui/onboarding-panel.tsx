"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useCan, useIsOwner } from "@/components/layout/permissions";

interface Step {
  id: "knowledge" | "channel" | "test_reply" | "activation";
  title: string;
  status: "pending" | "done" | "failed";
  detail?: string;
}
interface View {
  applicable: boolean;
  emailVerified: boolean;
  activated: boolean;
  steps: Step[];
}

const LINKS: Record<string, { href: string; label: string }> = {
  knowledge: { href: "/knowledge", label: "Open knowledge base" },
  channel: { href: "/channels", label: "Open channels" },
};

/** PLAN.md P3 — server-backed onboarding: state survives reloads; every failure shows a readable reason. */
export function OnboardingPanel() {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  // Activating the workspace and the test reply are owner actions; everyone else only sees progress.
  const isOwner = useIsOwner();
  const canOpenKnowledge = useCan("knowledge:create");
  const canOpenChannels = useCan("channels:read");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/onboarding", { cache: "no-store" });
      if (res.ok) {
        setView(await res.json());
        setLoadFailed(false);
      } else setLoadFailed(true);
    } catch {
      setLoadFailed(true); // the dashboard stays usable; say so instead of showing nothing
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(name: string, url: string, success: string) {
    if (busy) return;
    setBusy(name);
    setMessage("");
    setError("");
    try {
      const res = await fetch(url, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (res.ok) setMessage(success);
      else setError(body?.error?.message ?? body?.error ?? "That did not work. Try again.");
    } catch {
      setError("That did not work. Try again.");
    } finally {
      setBusy(null);
      await load();
    }
  }

  if (!view && loadFailed)
    return (
      <p role="status" className="rounded-xl border border-ziyrak-border bg-ziyrak-surface px-5 py-3 text-sm text-ziyrak-text-light">
        Setup progress could not be loaded.{" "}
        <button type="button" onClick={() => void load()} className="font-medium text-ziyrak-primary hover:underline">
          Try again
        </button>
      </p>
    );
  if (!view || !view.applicable || view.activated) return null;
  const allDone = view.steps.filter((s) => s.id !== "activation").every((s) => s.status === "done");
  return (
    <div id="onboardingPanel" className="bg-ziyrak-surface rounded-xl border border-ziyrak-border overflow-hidden">
      <div className="px-5 py-4 border-b border-ziyrak-border">
        <h3 className="font-semibold text-ziyrak-text">Finish setting up your workspace</h3>
        <p className="text-xs text-ziyrak-text-light mt-0.5">
          {isOwner
            ? "Until you activate it, visitors get a short notice instead of AI replies."
            : "Until the workspace owner activates it, visitors get a short notice instead of AI replies. Only the owner can run the test reply and activate."}
        </p>
      </div>
      {isOwner && !view.emailVerified && (
        <div id="verifyBanner" role="status" className="px-5 py-3 text-sm bg-ziyrak-bg border-b border-ziyrak-border">
          Confirm your email address to unlock the test reply and activation.{" "}
          <button
            id="resendVerification"
            type="button"
            disabled={busy !== null}
            onClick={() => act("resend", "/api/auth/resend-verification", "A new confirmation email is on its way.")}
            className="font-medium text-ziyrak-primary hover:underline disabled:opacity-60"
          >
            Send the email again
          </button>
        </div>
      )}
      <ol className="divide-y divide-ziyrak-border">
        {view.steps.map((step) => (
          <li key={step.id} data-step={step.id} data-status={step.status} className="flex items-center justify-between gap-4 px-5 py-3.5">
            <div>
              <p className="text-sm font-medium text-ziyrak-text">
                {step.status === "done" ? "Done: " : step.status === "failed" ? "Needs attention: " : ""}
                {step.title}
              </p>
              {step.detail && (
                <p role="alert" className="text-xs text-ziyrak-danger mt-0.5">
                  {step.detail}
                </p>
              )}
            </div>
            <div>
              {LINKS[step.id] && step.status !== "done" && (step.id === "knowledge" ? canOpenKnowledge : canOpenChannels) && (
                <Link href={LINKS[step.id].href} className="text-sm font-medium text-ziyrak-primary hover:underline">
                  {LINKS[step.id].label}
                </Link>
              )}
              {isOwner && step.id === "test_reply" && step.status !== "done" && (
                <button
                  id="runTestReply"
                  type="button"
                  disabled={busy !== null || !view.emailVerified || view.steps[0].status !== "done"}
                  onClick={() => act("test", "/api/onboarding/test-reply", "The assistant answered your test question.")}
                  className="rounded-lg bg-ziyrak-primary px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {busy === "test" ? "Asking..." : step.status === "failed" ? "Try again" : "Run test reply"}
                </button>
              )}
              {isOwner && step.id === "activation" && (
                <button
                  id="activateWorkspace"
                  type="button"
                  disabled={busy !== null || !view.emailVerified || !allDone}
                  onClick={() => act("activate", "/api/onboarding/activate", "Your workspace is active.")}
                  className="rounded-lg bg-ziyrak-primary px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {busy === "activate" ? "Activating..." : "Activate workspace"}
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
      {message && <p role="status" className="px-5 py-3 text-sm text-ziyrak-text">{message}</p>}
      {error && <p role="alert" className="px-5 py-3 text-sm text-ziyrak-danger">{error}</p>}
    </div>
  );
}
