"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Policy = {
  id: string;
  kind: string;
  version: number;
  active: boolean;
  displayName: string;
  provider: string;
  model: string;
  hasCredential: boolean;
  maxTokens: number;
};
type WorkspaceRow = {
  businessId: string;
  name: string;
  mode: string;
  status: string | null;
  generationLimitTokens: number | null;
  embeddingLimitTokens: number | null;
  generationUsed: number;
  embeddingUsed: number;
};
type PlatformLimitRow = { key: string; label: string; value: number; isDefault: boolean; max: number };
type Console = {
  policies: Policy[];
  workspaces: WorkspaceRow[];
  platformLimits: PlatformLimitRow[];
  platformUsage: { generation: number; embedding: number };
};
const field = "w-full rounded border border-ziyrak-border bg-ziyrak-bg p-2";
const cell = "pr-4 py-1 align-top";
const button = "rounded bg-ziyrak-primary px-4 py-2 text-white disabled:opacity-50";

export default function AiServicePage() {
  const router = useRouter();
  const [data, setData] = useState<Console | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState("generation");
  const [displayName, setDisplayName] = useState("Standard assistant");
  const [provider, setProvider] = useState("openai");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [maxTokens, setMaxTokens] = useState("1024");
  const [temperature, setTemperature] = useState("0.7");
  const [maxPromptTokens, setMaxPromptTokens] = useState("12000");
  const [maxToolDepth, setMaxToolDepth] = useState("5");
  const [policyReason, setPolicyReason] = useState("");
  const [businessId, setBusinessId] = useState("");
  const [mode, setMode] = useState("managed");
  const [status, setStatus] = useState("active");
  const [genLimit, setGenLimit] = useState("");
  const [embLimit, setEmbLimit] = useState("");
  const [allowanceReason, setAllowanceReason] = useState("");
  const [limitKey, setLimitKey] = useState("");
  const [limitValue, setLimitValue] = useState("");
  const [limitReason, setLimitReason] = useState("");

  async function load() {
    const response = await fetch("/api/platform/ai-service", { cache: "no-store" });
    if (response.status === 401) return router.replace("/login");
    if (response.status === 403) {
      setData(null);
      return setDenied(true);
    }
    if (!response.ok) throw new Error("Could not load the AI service. Try again.");
    setData(await response.json());
    setDenied(false);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function mutate(payload: object, success: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/platform/ai-service", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.status === 401) return router.replace("/login");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || "The change could not be saved");
      await load();
      setMessage(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The change could not be saved");
    } finally {
      setApiKey("");
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-ziyrak-border bg-ziyrak-surface p-6 shadow-lg">
      <h1 className="text-2xl font-bold">Managed AI service</h1>
      {denied ? (
        <p role="alert" className="mt-4">
          Access denied. Super admin authority is required.
        </p>
      ) : !data ? (
        <p role="status" className="mt-4">
          {error ? "The AI service is unavailable." : "Loading…"}
        </p>
      ) : (
        <>
          <p className="mt-3">
            Policies set the approved provider, model and key. Keys are write-only and never shown again. Limits are
            usage caps in tokens per UTC calendar month, not invoices.
          </p>
          {error && <p role="alert">{error}</p>}
          {message && <p role="status">{message}</p>}

          <h2 className="mt-6 text-xl font-semibold">Platform limits</h2>
          <p className="mt-1 text-sm">
            Safety ceilings across all workspaces. Used this month: replies {data.platformUsage.generation.toLocaleString()} tokens,
            knowledge {data.platformUsage.embedding.toLocaleString()} tokens (estimates, not invoices).
          </p>
          <table className="mt-2 w-full table-auto text-left text-sm" aria-label="Platform limits">
            <thead>
              <tr><th className={cell}>Limit</th><th className={cell}>Value</th><th className={cell}>Source</th></tr>
            </thead>
            <tbody>
              {data.platformLimits.map((l) => (
                <tr key={l.key}>
                  <td className={cell}>{l.label}</td><td className={cell}>{l.value.toLocaleString()}</td><td className={cell}>{l.isDefault ? "default" : "set by a super admin"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <form
            className="mt-4 space-y-3"
            aria-label="Set platform limit"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate({ action: "set_platform_limit", key: limitKey, value: Number(limitValue), reason: limitReason }, "Platform limit saved.");
            }}
          >
            <label>Limit
              <select id="limitKey" className={field} value={limitKey} onChange={(e) => setLimitKey(e.target.value)} required>
                <option value="">Select a limit</option>
                {data.platformLimits.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
              </select>
            </label>
            <label>New value<input id="limitValue" className={field} inputMode="numeric" value={limitValue} onChange={(e) => setLimitValue(e.target.value)} required /></label>
            <label>Reason<input id="limitReason" className={field} value={limitReason} onChange={(e) => setLimitReason(e.target.value)} required /></label>
            <button id="saveLimit" className={button} disabled={busy}>Save limit</button>
          </form>

          <h2 className="mt-8 text-xl font-semibold">Policies</h2>
          <table className="mt-2 w-full table-auto text-left text-sm" aria-label="Policies">
            <thead>
              <tr><th className={cell}>Kind</th><th className={cell}>Version</th><th className={cell}>Name</th><th className={cell}>Provider</th><th className={cell}>Model</th><th className={cell}>Key</th><th className={cell}>Active</th></tr>
            </thead>
            <tbody>
              {data.policies.map((p) => (
                <tr key={p.id}>
                  <td className={cell}>{p.kind}</td><td className={cell}>{p.version}</td><td className={cell}>{p.displayName}</td><td className={cell}>{p.provider}</td><td className={cell}>{p.model}</td>
                  <td className={cell}>{p.hasCredential ? "set" : "missing"}</td><td className={cell}>{p.active ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <form
            className="mt-4 space-y-3"
            aria-label="Save policy"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                {
                  action: "save_policy",
                  kind,
                  displayName,
                  provider,
                  model,
                  ...(apiKey ? { apiKey } : {}),
                  maxTokens: Number(maxTokens),
                  temperature: Number(temperature),
                  maxPromptTokens: Number(maxPromptTokens),
                  maxToolDepth: Number(maxToolDepth),
                  reason: policyReason,
                },
                "Policy saved as a new active version."
              );
            }}
          >
            <label>Kind
              <select id="policyKind" className={field} value={kind} onChange={(e) => { setKind(e.target.value); if (e.target.value === "embedding") setProvider("openai"); }}>
                <option value="generation">Generation</option><option value="embedding">Embedding</option>
              </select>
            </label>
            <label>Display name<input id="policyName" className={field} value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></label>
            <label>Provider
              <select id="policyProvider" className={field} value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="openai">OpenAI</option>
                {kind === "generation" && <option value="anthropic">Anthropic</option>}
              </select>
            </label>
            <label>Model<input id="policyModel" className={field} value={model} onChange={(e) => setModel(e.target.value)} required /></label>
            <label>API key (leave empty to keep the current key for this provider)
              <input id="policyKey" className={field} type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </label>
            <label>Max completion tokens<input className={field} inputMode="numeric" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} /></label>
            <label>Temperature<input className={field} inputMode="decimal" value={temperature} onChange={(e) => setTemperature(e.target.value)} /></label>
            <label>Max prompt tokens<input className={field} inputMode="numeric" value={maxPromptTokens} onChange={(e) => setMaxPromptTokens(e.target.value)} /></label>
            <label>Max tool-loop depth<input className={field} inputMode="numeric" value={maxToolDepth} onChange={(e) => setMaxToolDepth(e.target.value)} /></label>
            <label>Reason<input id="policyReason" className={field} value={policyReason} onChange={(e) => setPolicyReason(e.target.value)} required /></label>
            <button id="savePolicy" className={button} disabled={busy}>Save policy</button>
          </form>

          <h2 className="mt-8 text-xl font-semibold">Workspace allowances</h2>
          <table className="mt-2 w-full table-auto text-left text-sm" aria-label="Workspace allowances">
            <thead>
              <tr><th className={cell}>Workspace</th><th className={cell}>Mode</th><th className={cell}>Status</th><th className={cell}>Replies used / limit</th><th className={cell}>Knowledge used / limit</th></tr>
            </thead>
            <tbody>
              {data.workspaces.map((w) => (
                <tr key={w.businessId}>
                  <td className={cell}>{w.name}</td><td className={cell}>{w.mode}</td><td className={cell}>{w.status ?? "-"}</td>
                  <td className={cell}>{w.generationUsed.toLocaleString()} / {w.generationLimitTokens?.toLocaleString() ?? "-"}</td>
                  <td className={cell}>{w.embeddingUsed.toLocaleString()} / {w.embeddingLimitTokens?.toLocaleString() ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <form
            className="mt-4 space-y-3"
            aria-label="Set allowance"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                {
                  action: "set_allowance",
                  businessId,
                  mode,
                  status,
                  ...(genLimit ? { generationLimitTokens: Number(genLimit) } : {}),
                  ...(embLimit ? { embeddingLimitTokens: Number(embLimit) } : {}),
                  reason: allowanceReason,
                },
                "Allowance saved."
              );
            }}
          >
            <label>Workspace
              <select id="allowanceWorkspace" className={field} value={businessId} onChange={(e) => setBusinessId(e.target.value)} required>
                <option value="">Select a workspace</option>
                {data.workspaces.map((w) => <option key={w.businessId} value={w.businessId}>{w.name}</option>)}
              </select>
            </label>
            <label>Mode
              <select id="allowanceMode" className={field} value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="managed">Managed by the platform</option>
                <option value="legacy_byok">Workspace&apos;s own key</option>
              </select>
            </label>
            <label>Status
              <select id="allowanceStatus" className={field} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="active">Active</option><option value="suspended">Suspended</option><option value="pending_verification">Waiting for owner email</option>
              </select>
            </label>
            <label>Reply limit (tokens per month, empty keeps current)<input id="allowanceGen" className={field} inputMode="numeric" value={genLimit} onChange={(e) => setGenLimit(e.target.value)} /></label>
            <label>Knowledge limit (tokens per month, empty keeps current)<input id="allowanceEmb" className={field} inputMode="numeric" value={embLimit} onChange={(e) => setEmbLimit(e.target.value)} /></label>
            <label>Reason<input id="allowanceReason" className={field} value={allowanceReason} onChange={(e) => setAllowanceReason(e.target.value)} required /></label>
            <button id="saveAllowance" className={button} disabled={busy}>Save allowance</button>
          </form>
        </>
      )}
    </section>
  );
}
