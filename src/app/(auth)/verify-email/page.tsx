"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

function Confirm() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  async function confirm() {
    setState("busy");
    try {
      const res = await fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      setState(res.ok ? "done" : "failed");
    } catch {
      setState("failed");
    }
  }
  if (state === "done")
    return (
      <p id="verifyDone" role="status" className="mt-4 text-sm text-owly-text">
        Your email address is confirmed.{" "}
        <Link href="/login" className="font-medium text-owly-primary hover:underline">Continue to sign in</Link>
      </p>
    );
  return (
    <div className="mt-6 space-y-4">
      <p className="text-sm text-owly-text">Confirm that this is your email address to finish setting up your account.</p>
      {state === "failed" && <p role="alert" className="text-sm text-owly-danger">This link is invalid or has expired. Sign in and request a new one.</p>}
      <button id="confirmEmail" onClick={confirm} disabled={state === "busy" || !token} className="w-full rounded-lg bg-owly-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-owly-primary-dark disabled:opacity-60">Confirm email address</button>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="bg-owly-surface rounded-2xl shadow-lg border border-owly-border p-8">
      <h1 className="text-2xl font-bold text-owly-text">Confirm your email</h1>
      <Suspense fallback={null}><Confirm /></Suspense>
    </div>
  );
}
