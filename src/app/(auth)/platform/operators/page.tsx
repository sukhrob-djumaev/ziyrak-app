"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Operator = { id: string; username: string; name: string };
type Workspace = {
  id: string;
  name: string;
  channelConnections: { id: string; name: string; type: string }[];
};
type Assignment = {
  id: string;
  operatorUserId: string;
  businessId: string;
  allowedOperations: string[];
  scopeMode: string;
  expiresAt: string | null;
  revokedAt: string | null;
  connectionScopes: { connectionId: string }[];
};
type Invitation = { id: string; email: string; expiresAt: string };
type Console = {
  evaluatedAt: string;
  operators: Operator[];
  invitations: Invitation[];
  workspaces: Workspace[];
  assignments: Assignment[];
  allowedOperations: string[];
  truncated: boolean;
};
const field = "w-full rounded border border-ziyrak-border bg-ziyrak-bg p-2";
const button = "rounded bg-ziyrak-primary px-4 py-2 text-white disabled:opacity-50";
export default function OperatorsPage() {
  const router = useRouter();
  const [data, setData] = useState<Console | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [provisionReason, setProvisionReason] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteReason, setInviteReason] = useState("");
  const [operatorId, setOperatorId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [scopeKind, setScopeKind] = useState("connections");
  const [connections, setConnections] = useState<string[]>([]);
  const [operations, setOperations] = useState<string[]>([]);
  const [profile, setProfile] = useState("none");
  const [expires, setExpires] = useState("");
  const [assignmentReason, setAssignmentReason] = useState("");
  const [revokeReason, setRevokeReason] = useState("");
  async function load() {
    const response = await fetch("/api/platform/operators", { cache: "no-store" });
    if (response.status === 401) {
      router.replace("/login");
      return;
    }
    if (response.status === 403) {
      setData(null);
      setDenied(true);
      return;
    }
    if (!response.ok) throw new Error("Could not load operator management. Try again.");
    setData(await response.json());
    setDenied(false);
  }
  useEffect(() => {
    let active = true;
    fetch("/api/platform/operators", { cache: "no-store" })
      .then(async (response) => {
        if (!active) return;
        if (response.status === 401) {
          router.replace("/login");
          return;
        }
        if (response.status === 403) {
          setDenied(true);
          return;
        }
        if (!response.ok) throw new Error("Could not load operator management. Try again.");
        const body = await response.json();
        if (active) setData(body);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [router]);
  async function mutate(payload: object, success: string) {
    if (busy) return false;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/platform/operators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.status === 401) {
        setData(null);
        router.replace("/login");
        return false;
      }
      if (response.status === 403) {
        setData(null);
        setDenied(true);
      }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || "The change could not be saved");
      await load();
      setMessage(success);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "The change could not be saved");
      return false;
    } finally {
      setPassword("");
      setBusy(false);
    }
  }
  const selected = data?.workspaces.find((w) => w.id === workspaceId);
  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  return (
    <section className="rounded-2xl border border-ziyrak-border bg-ziyrak-surface p-6 shadow-lg">
      <h1 className="text-2xl font-bold">Platform operators</h1>
      {denied ? (
        <p role="alert" className="mt-4">
          Access denied. Super admin authority is required.
        </p>
      ) : !data ? (
        <p role="status" className="mt-4">
          {error ? "Operator management is unavailable." : "Loading operators…"}
        </p>
      ) : (
        <>
          <p className="mt-3">
            Create operator accounts and assign their support limits. Reading customer conversations
            requires an explicit support grant in Support grants.
          </p>
          {data.truncated && (
            <p role="status">Showing up to 200 entries per list. Some entries are not shown.</p>
          )}
          <form
            className="mt-6 space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              if (
                await mutate(
                  { action: "provision", username, password, name, reason: provisionReason },
                  "Operator account created."
                )
              ) {
                setUsername("");
                setName("");
                setProvisionReason("");
              }
            }}
          >
            <h2 className="text-xl font-semibold">Create operator</h2>
            <label className="block" htmlFor="operatorUsername">
              Username
            </label>
            <input
              id="operatorUsername"
              className={field}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={3}
              maxLength={100}
              pattern="[a-zA-Z0-9_.-]+"
              disabled={busy}
              autoComplete="off"
            />
            <label className="block" htmlFor="operatorName">
              Name
            </label>
            <input
              id="operatorName"
              className={field}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
              disabled={busy}
            />
            <label className="block" htmlFor="operatorPassword">
              Initial password
            </label>
            <input
              id="operatorPassword"
              type="password"
              className={field}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={12}
              maxLength={72}
              disabled={busy}
              autoComplete="new-password"
            />
            <p className="text-sm">
              Use a unique password of at least 12 characters, up to 72 UTF-8 bytes. Share it with
              the intended operator through your approved secure channel.
            </p>
            <label className="block" htmlFor="provisionReason">
              Reason for creating this account
            </label>
            <textarea
              id="provisionReason"
              className={field}
              value={provisionReason}
              onChange={(e) => setProvisionReason(e.target.value)}
              required
              maxLength={1000}
              disabled={busy}
            />
            <button id="createOperator" className={button} disabled={busy} type="submit">
              Create operator
            </button>
          </form>
          <form
            className="mt-8 space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              if (
                await mutate(
                  { action: "invite", email: inviteEmail, reason: inviteReason },
                  "Invitation sent."
                )
              ) {
                setInviteEmail("");
                setInviteReason("");
              }
            }}
          >
            <h2 className="text-xl font-semibold">Invite operator by email</h2>
            <p className="text-sm">
              The person chooses their own username and password from the emailed link (valid for 3
              days). The address must not already belong to an account.
            </p>
            <label className="block" htmlFor="inviteOperatorEmail">
              Email address
            </label>
            <input
              id="inviteOperatorEmail"
              type="email"
              className={field}
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              required
              maxLength={254}
              disabled={busy}
              autoComplete="off"
            />
            <label className="block" htmlFor="inviteOperatorReason">
              Reason for this invitation
            </label>
            <textarea
              id="inviteOperatorReason"
              className={field}
              value={inviteReason}
              onChange={(e) => setInviteReason(e.target.value)}
              required
              maxLength={1000}
              disabled={busy}
            />
            <button id="inviteOperator" className={button} disabled={busy} type="submit">
              Send invitation
            </button>
            {data.invitations.length > 0 && (
              <ul id="operatorInvitations" className="space-y-2">
                {data.invitations.map((invitation) => (
                  <li key={invitation.id} className="flex items-center justify-between gap-3 text-sm">
                    <span>
                      {invitation.email} — expires {new Date(invitation.expiresAt).toLocaleString()}
                    </span>
                    <button
                      type="button"
                      className="rounded border border-ziyrak-border px-3 py-1 disabled:opacity-50"
                      disabled={busy}
                      onClick={() =>
                        mutate(
                          {
                            action: "revokeInvitation",
                            invitationId: invitation.id,
                            reason: inviteReason.trim() || "Invitation revoked by super admin",
                          },
                          "Invitation revoked."
                        )
                      }
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </form>
          <form
            className="mt-8 space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              const scope = {
                kind: scopeKind,
                customerProfileAccess: profile,
                ...(scopeKind === "connections" ? { connectionIds: connections } : {}),
              };
              if (
                await mutate(
                  {
                    action: "assign",
                    operatorUserId: operatorId,
                    businessId: workspaceId,
                    allowedOperations: operations,
                    scope,
                    reason: assignmentReason,
                    expiresAt: expires ? new Date(expires).toISOString() : null,
                  },
                  "Workspace assignment created."
                )
              ) {
                setAssignmentReason("");
                setOperations([]);
                setConnections([]);
              }
            }}
          >
            <h2 className="text-xl font-semibold">Assign workspace</h2>
            <label className="block" htmlFor="assignedOperator">
              Operator
            </label>
            <select
              id="assignedOperator"
              className={field}
              value={operatorId}
              onChange={(e) => setOperatorId(e.target.value)}
              required
              disabled={busy}
            >
              <option value="">Choose an operator</option>
              {data.operators.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.username})
                </option>
              ))}
            </select>
            <label className="block" htmlFor="assignedWorkspace">
              Workspace
            </label>
            <select
              id="assignedWorkspace"
              className={field}
              value={workspaceId}
              onChange={(e) => {
                setWorkspaceId(e.target.value);
                setConnections([]);
              }}
              required
              disabled={busy}
            >
              <option value="">Choose a workspace</option>
              {data.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <fieldset disabled={busy} className="space-y-2">
              <legend>Permitted support operations</legend>
              {data.allowedOperations.map((op) => (
                <label key={op} className="flex gap-2">
                  <input
                    type="checkbox"
                    data-operation={op}
                    checked={operations.includes(op)}
                    onChange={() => setOperations(toggle(operations, op))}
                  />
                  {op.split(":").reverse().join(" ")}
                </label>
              ))}
            </fieldset>
            <label className="block" htmlFor="assignmentScope">
              Resource scope
            </label>
            <select
              id="assignmentScope"
              className={field}
              value={scopeKind}
              onChange={(e) => {
                setScopeKind(e.target.value);
                setConnections([]);
              }}
              disabled={busy}
            >
              <option value="connections">Selected connections</option>
              <option value="workspace">Full workspace</option>
            </select>
            {scopeKind === "connections" && (
              <fieldset disabled={busy} className="space-y-2">
                <legend>Connections</legend>
                {selected?.channelConnections.length ? (
                  selected.channelConnections.map((c) => (
                    <label key={c.id} className="flex gap-2">
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
                  <p>Choose a workspace with a connection.</p>
                )}
              </fieldset>
            )}
            <label className="block" htmlFor="assignmentProfile">
              Shared customer profiles
            </label>
            <select
              id="assignmentProfile"
              className={field}
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              disabled={busy}
            >
              <option value="none">No shared profile access</option>
              <option value="read">Read shared profiles</option>
            </select>
            <label className="block" htmlFor="assignmentExpiry">
              Assignment expiry (optional, local time)
            </label>
            <input
              id="assignmentExpiry"
              type="datetime-local"
              className={field}
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
              disabled={busy}
            />
            <label className="block" htmlFor="assignmentReason">
              Reason for this assignment
            </label>
            <textarea
              id="assignmentReason"
              className={field}
              value={assignmentReason}
              onChange={(e) => setAssignmentReason(e.target.value)}
              required
              maxLength={1000}
              disabled={busy}
            />
            <button
              id="createAssignment"
              className={button}
              type="submit"
              disabled={
                busy || !operations.length || (scopeKind === "connections" && !connections.length)
              }
            >
              Create assignment
            </button>
          </form>
          <div className="mt-8 space-y-4">
            <h2 className="text-xl font-semibold">Assignments and operator removal</h2>
            <p>
              Revoke an assignment and create a new one to change its limits. Removing an operator
              ends platform authority and revokes their assignments and support grants.
            </p>
            <label className="block" htmlFor="revocationReason">
              Reason for revocation or removal
            </label>
            <textarea
              id="revocationReason"
              className={field}
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              maxLength={1000}
              disabled={busy}
            />
            <ul className="space-y-4">
              {data.assignments.map((a) => (
                <li
                  key={a.id}
                  data-assignment={a.id}
                  className="rounded border border-ziyrak-border p-3"
                >
                  <p>
                    {data.operators.find((u) => u.id === a.operatorUserId)?.username ??
                      "Former operator"}{" "}
                    —{" "}
                    {data.workspaces.find((w) => w.id === a.businessId)?.name ??
                      "Unavailable workspace"}
                  </p>
                  <p>
                    {a.allowedOperations.join(", ")};{" "}
                    {a.scopeMode === "workspace"
                      ? "Full workspace"
                      : `${a.connectionScopes.length} selected connections`}
                  </p>
                  <p>
                    {a.revokedAt
                      ? "Revoked"
                      : a.expiresAt && Date.parse(a.expiresAt) <= Date.parse(data.evaluatedAt)
                        ? "Expired"
                        : "Assigned"}
                    {a.expiresAt && ` · Expires ${new Date(a.expiresAt).toLocaleString()}`}
                  </p>
                  <button
                    className={button}
                    disabled={busy || !!a.revokedAt || !revokeReason.trim()}
                    onClick={async () => {
                      if (
                        await mutate(
                          { action: "revoke", assignmentId: a.id, reason: revokeReason },
                          "Assignment revoked."
                        )
                      )
                        setRevokeReason("");
                    }}
                  >
                    Revoke assignment
                  </button>
                </li>
              ))}
            </ul>
            <ul className="space-y-3">
              {data.operators.map((u) => (
                <li
                  key={u.id}
                  data-operator={u.id}
                  className="flex flex-wrap items-center justify-between gap-3"
                >
                  <span>
                    {u.name} ({u.username})
                  </span>
                  <button
                    className={button}
                    disabled={busy || !revokeReason.trim()}
                    onClick={async () => {
                      if (
                        await mutate(
                          { action: "remove", operatorUserId: u.id, reason: revokeReason },
                          "Operator authority removed."
                        )
                      )
                        setRevokeReason("");
                    }}
                  >
                    Remove operator
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="mt-4 text-ziyrak-danger">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mt-4">
          {message}
        </p>
      )}
      <Link href="/platform/enrollment" className="mt-6 block text-ziyrak-primary">
        Platform enrollment
      </Link>
      <Link href="/workspaces" className="mt-3 block text-ziyrak-primary">
        Choose a workspace
      </Link>
    </section>
  );
}
