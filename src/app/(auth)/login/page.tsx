"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [secondFactor, setSecondFactor] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch("/api/auth");
        const data = await res.json();
        if (data.setupRequired) {
          router.replace("/setup");
          return;
        }
        if (data.authenticated) {
          if (data.mfaEnrollmentRequired) {
        router.replace("/platform/mfa");
        return;
      }
      router.replace(data.workspaceSelectionRequired ? "/workspaces" : "/");
          return;
        }
      } catch {
        // Allow login page to render
      }
      setChecking(false);
    }
    checkAuth();
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "login",
          username,
          password,
          ...(secondFactor && mfaCode.trim()
            ? useRecovery
              ? { recoveryCode: mfaCode.trim() }
              : { mfaCode: mfaCode.trim() }
            : {}),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.mfaRequired) {
          setSecondFactor(true);
          setMfaCode("");
        }
        setError(data.error || "Login failed. Please try again.");
        setLoading(false);
        return;
      }

      router.replace(data.workspaceSelectionRequired ? "/workspaces" : "/");
    } catch {
      setError("An unexpected error occurred. Please try again.");
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-ziyrak-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="bg-ziyrak-surface rounded-2xl shadow-lg border border-ziyrak-border p-8">
      <div className="flex flex-col items-center mb-8">
        <Image src="/ziyrak.png" alt="Ziyrak" width={56} height={56} className="mb-4" />
        <h1 className="text-2xl font-bold text-ziyrak-text">Welcome to Ziyrak</h1>
        <p className="text-ziyrak-text-light text-sm mt-1">Sign in to your account</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label htmlFor="username" className="block text-sm font-medium text-ziyrak-text mb-1.5">
            Username
          </label>
          <input
            id="username"
            type="text"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-lg border border-ziyrak-border bg-ziyrak-bg px-3.5 py-2.5 text-sm text-ziyrak-text placeholder:text-ziyrak-text-light focus:outline-none focus:ring-2 focus:ring-ziyrak-primary focus:border-transparent transition-shadow"
            placeholder="Enter your username"
          />
        </div>

        <div>
          <label htmlFor="password" className="block text-sm font-medium text-ziyrak-text mb-1.5">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-ziyrak-border bg-ziyrak-bg px-3.5 py-2.5 text-sm text-ziyrak-text placeholder:text-ziyrak-text-light focus:outline-none focus:ring-2 focus:ring-ziyrak-primary focus:border-transparent transition-shadow"
            placeholder="Enter your password"
          />
        </div>

        {secondFactor && (
          <div>
            <label htmlFor="mfaCode" className="block text-sm font-medium text-ziyrak-text mb-1.5">
              {useRecovery ? "Recovery code" : "Authenticator code"}
            </label>
            <input
              id="mfaCode"
              type="text"
              inputMode={useRecovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              required
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              className="w-full rounded-lg border border-ziyrak-border bg-ziyrak-bg px-3.5 py-2.5 text-sm text-ziyrak-text focus:outline-none focus:ring-2 focus:ring-ziyrak-primary focus:border-transparent transition-shadow"
              placeholder={useRecovery ? "XXXX-XXXX-XXXX-XXXX" : "6-digit code"}
            />
            <button
              id="toggleRecovery"
              type="button"
              onClick={() => {
                setUseRecovery(!useRecovery);
                setMfaCode("");
              }}
              className="mt-1.5 text-xs font-medium text-ziyrak-primary hover:underline"
            >
              {useRecovery ? "Use authenticator code" : "Use a recovery code"}
            </button>
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-ziyrak-danger">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-ziyrak-primary-fill px-4 py-2.5 text-sm font-semibold text-white hover:bg-ziyrak-primary-fill-hover focus:outline-none focus:ring-2 focus:ring-ziyrak-primary focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Signing in...
            </span>
          ) : (
            "Sign In"
          )}
        </button>
      </form>

      <p className="mt-4 text-center text-sm">
        <Link id="forgotPasswordLink" href="/forgot-password" className="font-medium text-ziyrak-primary hover:underline">
          Forgot your password?
        </Link>
      </p>

      <p className="mt-6 text-center text-sm text-ziyrak-text-light">
        New here?{" "}
        <Link href="/setup" className="font-medium text-ziyrak-primary hover:underline">
          Create a business
        </Link>
      </p>
    </div>
  );
}
