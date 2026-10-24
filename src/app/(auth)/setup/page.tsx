"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";

const STEPS = ["Create Your Account", "Business Profile", "Check Your Email"];

const TONE_OPTIONS = [
  { value: "friendly", label: "Friendly", desc: "Warm and approachable" },
  { value: "professional", label: "Professional", desc: "Polished and business-like" },
  { value: "formal", label: "Formal", desc: "Courteous and proper" },
  { value: "technical", label: "Technical", desc: "Precise and detailed" },
];

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Step 1 - Admin Account
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // Step 2 - Business Profile
  const [businessName, setBusinessName] = useState("");
  const [businessDesc, setBusinessDesc] = useState("");
  const [welcomeMessage, setWelcomeMessage] = useState("Hello! How can I help you today?");
  const [tone, setTone] = useState("friendly");

  async function handleNext() {
    setError("");
    setLoading(true);

    try {
      if (step === 0) {
        // Validate admin fields
        if (!name.trim() || !username.trim() || !email.trim() || !password) {
          setError("All fields are required.");
          setLoading(false);
          return;
        }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
          setError("Enter a valid email address.");
          setLoading(false);
          return;
        }
        if (password.length < 8) {
          setError("Password must be at least 8 characters.");
          setLoading(false);
          return;
        }
        if (password !== confirmPassword) {
          setError("Passwords do not match.");
          setLoading(false);
          return;
        }

        // Nothing is created yet: the account and the business are created
        // together, atomically, when the business profile step is submitted
        // (PLAN.md §46.7 task 3) — so a half-finished signup never leaves an
        // owner without a business.
        setStep(1);
      } else if (step === 1) {
        if (!businessName.trim()) {
          setError("Business name is required.");
          setLoading(false);
          return;
        }

        const res = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "signup",
            name,
            username,
            email: email.trim(),
            password,
            businessName: businessName.trim(),
            businessDesc: businessDesc.trim(),
            welcomeMessage: welcomeMessage.trim(),
            tone,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(typeof data.error === "string" ? data.error : "Signup failed.");
          setLoading(false);
          return;
        }
        setStep(2);
      }
    } catch {
      setError("An unexpected error occurred. Please try again.");
    }

    setLoading(false);
  }

  function handleBack() {
    setError("");
    setStep((s) => Math.max(0, s - 1));
  }

  return (
    <div className="bg-ziyrak-surface rounded-2xl shadow-lg border border-ziyrak-border overflow-hidden">
      {/* Header */}
      <div className="bg-ziyrak-primary-50 border-b border-ziyrak-border px-8 pt-6 pb-4">
        <div className="flex items-center gap-3 mb-5">
          <Image src="/ziyrak.png" alt="Ziyrak" width={40} height={40} />
          <div>
            <h1 className="text-lg font-bold text-ziyrak-text">Create Your Business</h1>
            <p className="text-xs text-ziyrak-text-light">
              Step {step + 1} of {STEPS.length}
            </p>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="flex gap-1.5">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className="h-1.5 flex-1 rounded-full transition-colors duration-300"
              style={{
                backgroundColor:
                  i <= step
                    ? "var(--ziyrak-primary)"
                    : "var(--ziyrak-border)",
              }}
            />
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="px-8 py-6">
        <h2 className="text-xl font-bold text-ziyrak-text mb-1">
          {STEPS[step]}
        </h2>

        {/* Step 0: Admin Account */}
        {step === 0 && (
          <>
            <p className="text-sm text-ziyrak-text-light mb-6">
              Create the owner account for your new business.
            </p>
            <div className="space-y-4">
              <Field
                id="name"
                label="Full Name"
                value={name}
                onChange={setName}
                placeholder="Your name"
                autoComplete="name"
              />
              <Field
                id="username"
                label="Username"
                value={username}
                onChange={setUsername}
                placeholder="Choose a username"
                autoComplete="username"
              />
              <Field
                id="email"
                label="Email address"
                type="email"
                value={email}
                onChange={setEmail}
                placeholder="you@example.com"
                autoComplete="email"
              />
              <Field
                id="password"
                label="Password"
                type="password"
                value={password}
                onChange={setPassword}
                placeholder="At least 8 characters"
                autoComplete="new-password"
              />
              <Field
                id="confirmPassword"
                label="Confirm Password"
                type="password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                placeholder="Re-enter your password"
                autoComplete="new-password"
              />
            </div>
          </>
        )}

        {/* Step 1: Business Profile */}
        {step === 1 && (
          <>
            <p className="text-sm text-ziyrak-text-light mb-6">
              Tell us about your business so Ziyrak can represent you.
            </p>
            <div className="space-y-4">
              <Field
                id="businessName"
                label="Business Name"
                value={businessName}
                onChange={setBusinessName}
                placeholder="Your company or brand name"
              />
              <div>
                <label
                  htmlFor="businessDesc"
                  className="block text-sm font-medium text-ziyrak-text mb-1.5"
                >
                  Description
                </label>
                <textarea
                  id="businessDesc"
                  rows={3}
                  value={businessDesc}
                  onChange={(e) => setBusinessDesc(e.target.value)}
                  placeholder="Briefly describe what your business does"
                  className="w-full rounded-lg border border-ziyrak-border bg-ziyrak-bg px-3.5 py-2.5 text-sm text-ziyrak-text placeholder:text-ziyrak-text-light focus:outline-none focus:ring-2 focus:ring-ziyrak-primary focus:border-transparent transition-shadow resize-none"
                />
              </div>
              <Field
                id="welcomeMessage"
                label="Welcome Message"
                value={welcomeMessage}
                onChange={setWelcomeMessage}
                placeholder="The first message customers see"
              />
              <div>
                <label className="block text-sm font-medium text-ziyrak-text mb-2">
                  Response Tone
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {TONE_OPTIONS.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setTone(t.value)}
                      className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        tone === t.value
                          ? "border-ziyrak-primary bg-ziyrak-primary-50 ring-1 ring-ziyrak-primary"
                          : "border-ziyrak-border bg-ziyrak-bg hover:border-ziyrak-primary-light"
                      }`}
                    >
                      <div className="text-sm font-medium text-ziyrak-text">
                        {t.label}
                      </div>
                      <div className="text-xs text-ziyrak-text-light">
                        {t.desc}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        {/* Step 2: Check your email */}
        {step === 2 && (
          <div id="checkEmail" role="status">
            <p className="text-sm text-ziyrak-text mb-4">
              We sent a confirmation link to <strong>{email.trim()}</strong>. Open it to confirm your address, then
              sign in to finish setting up your business. The link works once and expires in 24 hours.
            </p>
            <p className="text-sm text-ziyrak-text-light">
              If you do not see it, check your spam folder. After you sign in you can ask for a new link.
            </p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mt-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-ziyrak-danger">
            {error}
          </div>
        )}
      </div>

      {/* Footer Buttons */}
      <div className="border-t border-ziyrak-border px-8 py-4 flex items-center justify-between">
        {step === 1 ? (
          <button
            type="button"
            onClick={handleBack}
            disabled={loading}
            className="rounded-lg border border-ziyrak-border bg-white px-4 py-2 text-sm font-medium text-ziyrak-text hover:bg-ziyrak-bg disabled:opacity-60 transition-colors"
          >
            Back
          </button>
        ) : (
          <div />
        )}

        {step < 2 ? (
          <button
            type="button"
            onClick={handleNext}
            disabled={loading}
            className="rounded-lg bg-ziyrak-primary px-5 py-2 text-sm font-semibold text-white hover:bg-ziyrak-primary-dark focus:outline-none focus:ring-2 focus:ring-ziyrak-primary focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Saving...
              </span>
            ) : step === 1 ? (
              "Create Business"
            ) : (
              "Next"
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => router.replace("/login")}
            className="rounded-lg bg-ziyrak-primary px-5 py-2 text-sm font-semibold text-white hover:bg-ziyrak-primary-dark focus:outline-none focus:ring-2 focus:ring-ziyrak-primary focus:ring-offset-2 transition-colors"
          >
            Go to sign in
          </button>
        )}
      </div>
    </div>
  );
}

/* ---- Helper Components ---- */

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-sm font-medium text-ziyrak-text mb-1.5"
      >
        {label}
      </label>
      <input
        id={id}
        type={type}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-ziyrak-border bg-ziyrak-bg px-3.5 py-2.5 text-sm text-ziyrak-text placeholder:text-ziyrak-text-light focus:outline-none focus:ring-2 focus:ring-ziyrak-primary focus:border-transparent transition-shadow"
      />
    </div>
  );
}
