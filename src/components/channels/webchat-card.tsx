"use client";

import { useCallback, useEffect, useState } from "react";
import { Globe, Loader2, Copy, RefreshCw, Save, CheckCircle } from "lucide-react";

/**
 * PLAN.md §20.4/§46.7 — the minimal dashboard UI for a business to create
 * its Web Chat widget, manage its allowed origins, rotate its publishable
 * token, and copy the embed snippet. The token is shown exactly once (on
 * create/rotate) — the server never returns it again — so the snippet is
 * only available immediately after one of those two actions.
 */

interface WebChatConnection {
  connectionId: string;
  name: string;
  isActive: boolean;
  allowedOrigins: string[];
}

interface IssuedSnippet {
  connectionId: string;
  embedSnippet: string;
}

export function WebChatCard() {
  const [connections, setConnections] = useState<WebChatConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [originsText, setOriginsText] = useState("");
  const [issued, setIssued] = useState<IssuedSnippet | null>(null);
  const [copied, setCopied] = useState(false);

  const connection = connections[0] ?? null;

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/channels/webchat-connections");
      if (!res.ok) throw new Error();
      const body = await res.json();
      const list = (body.data ?? []) as WebChatConnection[];
      setConnections(list);
      setOriginsText((list[0]?.allowedOrigins ?? []).join("\n"));
    } catch {
      setError("Could not load Web Chat settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function parseOrigins(): string[] {
    return originsText
      .split(/[\n,]/)
      .map((o) => o.trim())
      .filter(Boolean);
  }

  async function submit(url: string, method: string, body?: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = typeof data.error === "string" ? data.error : data.error?.message;
        setError(message || "Request failed.");
        return null;
      }
      return data;
    } catch {
      setError("Request failed.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    const created = await submit("/api/channels/webchat-connections", "POST", { allowedOrigins: parseOrigins() });
    if (created) {
      setIssued({ connectionId: String(created.connectionId), embedSnippet: String(created.embedSnippet) });
      await load();
    }
  }

  async function handleSaveOrigins() {
    if (!connection) return;
    const updated = await submit(`/api/channels/webchat-connections/${connection.connectionId}`, "PATCH", {
      allowedOrigins: parseOrigins(),
    });
    if (updated) await load();
  }

  async function handleRotate() {
    if (!connection) return;
    if (!window.confirm("Rotating the token immediately stops every site using the old embed snippet. Continue?")) return;
    const rotated = await submit(`/api/channels/webchat-connections/${connection.connectionId}/rotate-token`, "POST");
    if (rotated) setIssued({ connectionId: String(rotated.connectionId), embedSnippet: String(rotated.embedSnippet) });
  }

  async function copySnippet() {
    if (!issued) return;
    await navigator.clipboard.writeText(issued.embedSnippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="bg-owly-surface rounded-xl border border-owly-border overflow-hidden">
      <div className="px-5 py-4 border-b border-owly-border flex items-center gap-3">
        <div className="h-9 w-9 rounded-lg bg-blue-500/10 flex items-center justify-center">
          <Globe className="h-5 w-5 text-blue-600" />
        </div>
        <div>
          <h3 className="font-semibold text-owly-text">Web Chat</h3>
          <p className="text-xs text-owly-text-light mt-0.5">Embed a chat widget on your website</p>
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin text-owly-primary" />
        ) : (
          <>
            <div>
              <label htmlFor="webchat-origins" className="block text-xs font-medium text-owly-text-light mb-1">
                Allowed origins (one per line)
              </label>
              <textarea
                id="webchat-origins"
                rows={3}
                value={originsText}
                onChange={(e) => setOriginsText(e.target.value)}
                placeholder="https://www.example.com"
                className="w-full px-3 py-2 text-sm border border-owly-border rounded-lg bg-owly-bg text-owly-text focus:outline-none focus:ring-2 focus:ring-owly-primary/30"
              />
              <p className="text-xs text-owly-text-light mt-1">
                Only pages served from these exact origins (scheme + host + port) can use the widget.
              </p>
            </div>

            {issued && (
              <div className="rounded-lg border border-owly-border bg-owly-bg p-3">
                <p className="text-xs font-medium text-owly-text mb-2">
                  Paste this on your site. The token is shown only once — rotate it to get a new one.
                </p>
                <pre className="text-xs whitespace-pre-wrap break-all text-owly-text">{issued.embedSnippet}</pre>
                <button
                  type="button"
                  onClick={copySnippet}
                  className="mt-2 flex items-center gap-1.5 text-xs font-medium text-owly-primary"
                >
                  {copied ? <CheckCircle className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copied" : "Copy snippet"}
                </button>
              </div>
            )}

            {error && <p className="text-xs text-red-600">{error}</p>}
          </>
        )}
      </div>

      <div className="px-5 py-3 border-t border-owly-border bg-owly-bg/50 flex items-center gap-2">
        {!connection ? (
          <button
            type="button"
            onClick={handleCreate}
            disabled={busy || loading}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-owly-primary rounded-lg disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
            Create widget
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={handleSaveOrigins}
              disabled={busy}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-owly-primary rounded-lg disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              Save origins
            </button>
            <button
              type="button"
              onClick={handleRotate}
              disabled={busy}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-owly-text border border-owly-border rounded-lg disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" />
              Rotate token
            </button>
          </>
        )}
      </div>
    </div>
  );
}
