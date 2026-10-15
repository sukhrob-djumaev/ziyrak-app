"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import LimitedSupportList from "./limited-list";

type Scope = {
  scopeMode: string;
  customerProfileAccess: string;
  connectionScopes: { connectionId: string }[];
};
type Assignment = Scope & {
  id: string;
  businessId: string;
  allowedOperations: string[];
  expiresAt: string | null;
};
type Grant = Assignment & { reason: string; revokedAt: string | null };
type Workspace = {
  id: string;
  name: string;
  channelConnections: { id: string; name: string; type: string }[];
};
type Console = {
  role: "operator" | "super_admin";
  evaluatedAt: string;
  assignments: Assignment[];
  workspaces: Workspace[];
  grants: Grant[];
  allowedOperations: string[];
  truncated: boolean;
};
const field = "w-full rounded border border-owly-border bg-owly-bg p-2";
const button = "rounded bg-owly-primary px-4 py-2 text-white disabled:opacity-50";
const operationName = (op: string) => `Read ${op.split(":")[0]}`;
export default function SupportPage() {
  const router = useRouter();
  const [data, setData] = useState<Console | null>(null),
    [denied, setDenied] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [target, setTarget] = useState(""),
    [scope, setScope] = useState("connections"),
    [connections, setConnections] = useState<string[]>([]),
    [operations, setOperations] = useState<string[]>([]);
  const [profile, setProfile] = useState("none"),
    [reason, setReason] = useState(""),
    [expiry, setExpiry] = useState(""),
    [revokeReason, setRevokeReason] = useState("");
  const pending = useRef<{ signature: string; requestId: string } | null>(null);
  const [viewGrant, setViewGrant] = useState<Grant | null>(null);
  async function accept(response: Response) {
    if (response.status === 401) {
      setViewGrant(null);
      setData(null);
      router.replace("/login");
      return;
    }
    if (response.status === 403) {
      setViewGrant(null);
      setData(null);
      setDenied(true);
      return;
    }
    if (!response.ok) throw new Error("Could not load support grants. Try again.");
    setData(await response.json());
    setDenied(false);
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/platform/support-grants", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          router.replace("/login");
          return;
        }
        if (response.status === 403) {
          setDenied(true);
          return;
        }
        if (!response.ok) throw new Error("Could not load support grants. Try again.");
        const body = await response.json();
        if (!controller.signal.aborted) setData(body);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not load support grants.");
      });
    return () => controller.abort();
  }, [router]);
  async function mutate(payload: object, success: string) {
    if (busy) return false;
    setViewGrant(null);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/platform/support-grants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.status === 401) {
        setData(null);
        router.replace("/login");
        return false;
      }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || "The request could not be saved.");
      await accept(await fetch("/api/platform/support-grants", { cache: "no-store" }));
      setMessage(success);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request could not be saved.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  const assignment =
    data?.role === "operator" ? data.assignments.find((a) => a.id === target) : undefined;
  const workspace = data?.workspaces.find((w) => w.id === (assignment?.businessId ?? target));
  const choices =
    data?.role === "operator"
      ? (assignment?.allowedOperations.filter((op) => data.allowedOperations.includes(op)) ?? [])
      : (data?.allowedOperations ?? []);
  const connectionChoices =
    workspace?.channelConnections.filter(
      (c) =>
        !assignment ||
        assignment.scopeMode === "workspace" ||
        assignment.connectionScopes.some((s) => s.connectionId === c.id)
    ) ?? [];
  const toggle = (values: string[], value: string) =>
    values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
  return (
    <section className="rounded-2xl border border-owly-border bg-owly-surface p-6 shadow-lg">
      <h1 className="text-2xl font-bold">Support grants</h1>
      {denied ? (
        <p role="alert" className="mt-4">
          Access denied. Current platform authority is required.
        </p>
      ) : !data ? (
        <p role="status" className="mt-4">
          {error ? "Support grants are unavailable." : "Loading support grants…"}
        </p>
      ) : (
        <>
          <p className="mt-3">
            Record the workspace, permitted reads, reason and expiry for your support request.
            Grants that permit reading conversations can open a limited conversation list.
          </p>
          {data.truncated && (
            <p role="status">Showing up to 200 entries per list. Some entries are not shown.</p>
          )}
          <form
            className="mt-6 space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!workspace) return;
              const expiresAt = new Date(expiry);
              if (!Number.isFinite(expiresAt.getTime())) {
                setError("Choose a valid expiry.");
                return;
              }
              const input = {
                businessId: workspace.id,
                ...(assignment ? { assignmentId: assignment.id } : {}),
                allowedOperations: [...operations].sort(),
                scope: {
                  kind: scope,
                  customerProfileAccess: profile,
                  ...(scope === "connections" ? { connectionIds: [...connections].sort() } : {}),
                },
                reason,
                expiresAt: expiresAt.toISOString(),
              };
              const signature = JSON.stringify(input);
              if (pending.current?.signature !== signature)
                pending.current = { signature, requestId: crypto.randomUUID() };
              if (
                await mutate(
                  { action: "issue", ...input, requestId: pending.current.requestId },
                  "Support grant recorded. Use View limited conversation list for permitted conversation reads."
                )
              ) {
                pending.current = null;
                setReason("");
                setOperations([]);
                setConnections([]);
              }
            }}
          >
            <h2 className="text-xl font-semibold">Request support access</h2>
            <label className="block" htmlFor="supportTarget">
              {data.role === "operator" ? "Workspace assignment" : "Workspace"}
            </label>
            <select
              id="supportTarget"
              className={field}
              value={target}
              required
              disabled={busy}
              onChange={(e) => {
                setViewGrant(null);
                setTarget(e.target.value);
                setConnections([]);
                setOperations([]);
                setScope("connections");
                setProfile("none");
              }}
            >
              <option value="">
                Choose {data.role === "operator" ? "an assignment" : "a workspace"}
              </option>
              {data.role === "operator"
                ? data.assignments.map((a) => (
                    <option key={a.id} value={a.id}>
                      {data.workspaces.find((w) => w.id === a.businessId)?.name ??
                        "Unavailable workspace"}{" "}
                      ·{" "}
                      {a.scopeMode === "workspace"
                        ? "Full workspace"
                        : `${a.connectionScopes.length} connections`}
                      {a.expiresAt ? ` · Expires ${new Date(a.expiresAt).toLocaleString()}` : ""}
                    </option>
                  ))
                : data.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
            </select>
            <fieldset disabled={busy} className="space-y-2">
              <legend>Permitted reads</legend>
              {choices.map((op) => (
                <label key={op} className="flex gap-2">
                  <input
                    type="checkbox"
                    data-operation={op}
                    checked={operations.includes(op)}
                    onChange={() => setOperations(toggle(operations, op))}
                  />
                  {operationName(op)}
                </label>
              ))}
            </fieldset>
            <label className="block" htmlFor="supportScope">
              Resources
            </label>
            <select
              id="supportScope"
              className={field}
              disabled={busy}
              value={scope}
              onChange={(e) => {
                setScope(e.target.value);
                setConnections([]);
              }}
            >
              <option value="connections">Selected connections</option>
              {(!assignment || assignment.scopeMode === "workspace") && (
                <option value="workspace">Full workspace</option>
              )}
            </select>
            {scope === "connections" && (
              <fieldset disabled={busy} className="space-y-2">
                <legend>Connections</legend>
                {connectionChoices.length ? (
                  connectionChoices.map((c) => (
                    <label className="flex gap-2" key={c.id}>
                      <input
                        type="checkbox"
                        data-connection={c.id}
                        checked={connections.includes(c.id)}
                        onChange={() => setConnections(toggle(connections, c.id))}
                      />
                      {c.name} ({c.type})
                    </label>
                  ))
                ) : (
                  <p>Choose a workspace or assignment with an available connection.</p>
                )}
              </fieldset>
            )}
            <label className="block" htmlFor="supportProfile">
              Shared customer profiles
            </label>
            <select
              id="supportProfile"
              className={field}
              value={profile}
              disabled={busy}
              onChange={(e) => setProfile(e.target.value)}
            >
              <option value="none">No shared profile access</option>
              {(!assignment || assignment.customerProfileAccess !== "none") && (
                <option value="read">Read shared profiles</option>
              )}
            </select>
            <label className="block" htmlFor="supportReason">
              Reason for this access
            </label>
            <textarea
              id="supportReason"
              className={field}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              maxLength={1000}
              disabled={busy}
            />
            <label className="block" htmlFor="supportExpiry">
              Expiry (local time, within 24 hours)
            </label>
            <input
              id="supportExpiry"
              type="datetime-local"
              className={field}
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              required
              disabled={busy}
            />
            {assignment?.expiresAt && (
              <p className="text-sm">
                Expiry must also be no later than {new Date(assignment.expiresAt).toLocaleString()}.
              </p>
            )}
            <button
              id="issueSupportGrant"
              type="submit"
              className={button}
              disabled={
                busy ||
                !workspace ||
                !operations.length ||
                (scope === "connections" && !connections.length)
              }
            >
              Record grant
            </button>
          </form>
          <div className="mt-8 space-y-3">
            <h2 className="text-xl font-semibold">Your grants</h2>
            <label className="block" htmlFor="supportRevokeReason">
              Reason for revocation
            </label>
            <textarea
              id="supportRevokeReason"
              className={field}
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              maxLength={1000}
              disabled={busy}
            />
            {!data.grants.length && <p>No grants recorded.</p>}
            <ul className="space-y-4">
              {data.grants.map((g) => (
                <li
                  key={g.id}
                  data-grant={g.id}
                  className="rounded border border-owly-border p-3 space-y-2"
                >
                  <p className="font-semibold">
                    {data.workspaces.find((w) => w.id === g.businessId)?.name ??
                      "Unavailable workspace"}
                  </p>
                  <p>{g.reason}</p>
                  <p>{g.allowedOperations.map(operationName).join(", ")}</p>
                  <p>
                    {g.scopeMode === "workspace"
                      ? "Full workspace"
                      : `${g.connectionScopes.length} selected connections`}
                    ;{" "}
                    {g.customerProfileAccess === "none"
                      ? "no shared profile access"
                      : "shared profiles permitted"}
                  </p>
                  <p>
                    {g.revokedAt
                      ? "Revoked"
                      : g.expiresAt && Date.parse(g.expiresAt) <= Date.parse(data.evaluatedAt)
                        ? "Expired"
                        : "Recorded"}{" "}
                    · Expires {g.expiresAt ? new Date(g.expiresAt).toLocaleString() : "Unavailable"}
                  </p>
                  <button
                    className={button}
                    data-action="view-support-list"
                    disabled={
                      busy ||
                      !!g.revokedAt ||
                      !g.expiresAt ||
                      Date.parse(g.expiresAt) <= Date.parse(data.evaluatedAt) ||
                      !g.allowedOperations.includes("conversations:read")
                    }
                    onClick={() => setViewGrant(g)}
                  >
                    View limited conversation list
                  </button>
                  <button
                    className={button}
                    data-action="revoke-support-grant"
                    disabled={busy || !!g.revokedAt || !revokeReason.trim()}
                    onClick={async () => {
                      if (
                        await mutate(
                          { action: "revoke", grantId: g.id, reason: revokeReason },
                          "Support grant revoked."
                        )
                      )
                        setRevokeReason("");
                    }}
                  >
                    Revoke grant
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {viewGrant && (
            <LimitedSupportList
              key={viewGrant.id}
              grant={viewGrant}
              onClose={() => setViewGrant(null)}
            />
          )}
        </>
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
      <Link href="/platform/enrollment" className="mt-6 block text-owly-primary">
        Platform account
      </Link>
      <Link href="/workspaces" className="mt-3 block text-owly-primary">
        Choose a workspace
      </Link>
    </section>
  );
}
