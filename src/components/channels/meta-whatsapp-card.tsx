"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageCircle, Loader2, Save, CheckCircle } from "lucide-react";

/**
 * PLAN.md §20.2/§46.7 — the tenant-facing WhatsApp setup: a business's own
 * Meta Cloud API phone number id + system-user access token. Replaces the
 * QR-code (whatsapp-web.js) card as what a normal business sees — that
 * adapter is dev/demo-only (§20.1). The access token is write-only: it is
 * encrypted on save and never sent back to the browser.
 */

interface ChannelView {
  id: string | null;
  isActive: boolean;
  config: { phoneNumberId?: string };
}

export function MetaWhatsAppCard() {
  const [channel, setChannel] = useState<ChannelView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [accessToken, setAccessToken] = useState("");

  const webhookUrl = typeof window !== "undefined" ? `${window.location.origin}/api/channels/whatsapp-cloud/webhook` : "";

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/channels/whatsapp_cloud");
      if (!res.ok) throw new Error();
      const data = (await res.json()) as ChannelView;
      setChannel(data);
      setPhoneNumberId(data.config?.phoneNumberId ?? "");
    } catch {
      setError("Could not load WhatsApp settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    if (!phoneNumberId.trim() || !accessToken.trim() || !businessAccountId.trim()) {
      setError("Phone number ID, business account ID, and access token are all required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/channels/whatsapp_cloud", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isActive: true,
          status: "connected",
          config: { phoneNumberId: phoneNumberId.trim() },
          credential: {
            type: "whatsapp_cloud",
            phoneNumberId: phoneNumberId.trim(),
            accessToken: accessToken.trim(),
            businessAccountId: businessAccountId.trim(),
          },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((typeof data.error === "string" ? data.error : data.error?.message) || "Failed to save.");
        return;
      }
      setAccessToken("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await load();
    } catch {
      setError("Failed to save.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "w-full px-3 py-2 text-sm border border-owly-border rounded-lg bg-owly-bg text-owly-text focus:outline-none focus:ring-2 focus:ring-owly-primary/30";

  return (
    <div className="bg-owly-surface rounded-xl border border-owly-border overflow-hidden">
      <div className="px-5 py-4 border-b border-owly-border flex items-center gap-3">
        <div className="h-9 w-9 rounded-lg bg-green-500/10 flex items-center justify-center">
          <MessageCircle className="h-5 w-5 text-green-600" />
        </div>
        <div>
          <h3 className="font-semibold text-owly-text">WhatsApp</h3>
          <p className="text-xs text-owly-text-light mt-0.5">
            {channel?.isActive ? "Connected via Meta Cloud API" : "Connect your WhatsApp Business number"}
          </p>
        </div>
      </div>

      <div className="px-5 py-4 space-y-3">
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin text-owly-primary" />
        ) : (
          <>
            <div>
              <label htmlFor="wa-phone-id" className="block text-xs font-medium text-owly-text-light mb-1">
                Phone number ID
              </label>
              <input id="wa-phone-id" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label htmlFor="wa-waba-id" className="block text-xs font-medium text-owly-text-light mb-1">
                WhatsApp Business Account ID
              </label>
              <input id="wa-waba-id" value={businessAccountId} onChange={(e) => setBusinessAccountId(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label htmlFor="wa-token" className="block text-xs font-medium text-owly-text-light mb-1">
                Access token (system user)
              </label>
              <input
                id="wa-token"
                type="password"
                autoComplete="off"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder={channel?.id ? "Enter a new token to replace the saved one" : ""}
                className={inputClass}
              />
            </div>
            <p className="text-xs text-owly-text-light">
              In your Meta App&apos;s WhatsApp settings, set the webhook callback URL to{" "}
              <span className="font-mono break-all">{webhookUrl}</span> and subscribe to the <span className="font-mono">messages</span> field.
            </p>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </>
        )}
      </div>

      <div className="px-5 py-3 border-t border-owly-border bg-owly-bg/50">
        <button
          type="button"
          onClick={handleSave}
          disabled={busy || loading}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-owly-primary rounded-lg disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <CheckCircle className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          {saved ? "Saved" : "Save"}
        </button>
      </div>
    </div>
  );
}
