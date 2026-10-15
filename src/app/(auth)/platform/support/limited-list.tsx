"use client";
import { useCallback, useEffect, useRef, useState } from "react";

type Grant = { id: string; businessId: string; expiresAt: string | null };
type Row = {
  id: string;
  customerName: string | null;
  customerContact: string | null;
  channel: string;
  status: string;
  updatedAt: string;
};
type Result = { data: Row[]; pagination: { page: number; total: number; totalPages: number } };
const button = "rounded border border-owly-border px-3 py-2 disabled:opacity-50";

/** Request-local limited view. Unmount on grant change/revoke/close. */
export default function LimitedSupportList({
  grant,
  onClose,
}: {
  grant: Grant;
  onClose: () => void;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = useRef<{ sequence: number; controller: AbortController | null }>({
    sequence: 0,
    controller: null,
  });
  const query = useRef({ search: "", page: 1 });
  const load = useCallback(
    async (page: number, search: string, clearSelection = false) => {
      current.current.controller?.abort();
      const controller = new AbortController();
      const sequence = ++current.current.sequence;
      current.current.controller = controller;
      const active = () => !controller.signal.aborted && current.current.sequence === sequence;
      setResult(null);
      setError("");
      setConflict(false);
      setBusy(true);
      query.current = { page, search };
      try {
        if (clearSelection) {
          const cleared = await fetch("/api/workspaces", {
            method: "DELETE",
            cache: "no-store",
            signal: controller.signal,
          });
          if (!active()) return;
          if (!cleared.ok)
            throw new Error("Could not clear workspace selection. Sign in and try again.");
        }
        const response = await fetch(
          "/api/conversations?" + new URLSearchParams({ page: String(page), limit: "10", search }),
          {
            cache: "no-store",
            signal: controller.signal,
            headers: { "x-support-grant-id": grant.id, "x-workspace-id": grant.businessId },
          }
        );
        const body = await response.json();
        if (!active()) return;
        if (!response.ok) {
          setConflict(body.error?.code === "WORKSPACE_SELECTION_CONFLICT");
          throw new Error(
            response.status === 401
              ? "Sign in again to use this support grant."
              : body.error?.message || "This support list is unavailable."
          );
        }
        setResult(body);
      } catch (error) {
        if (active())
          setError(error instanceof Error ? error.message : "This support list is unavailable.");
      } finally {
        if (active()) setBusy(false);
      }
    },
    [grant.id, grant.businessId]
  );
  useEffect(() => {
    void load(1, "");
    const lifetime = grant.expiresAt ? Date.parse(grant.expiresAt) - Date.now() : 0;
    const timer = setTimeout(
      () => {
        current.current.controller?.abort();
        ++current.current.sequence;
        setResult(null);
        setBusy(false);
        setConflict(false);
        setError("This support grant has expired.");
      },
      Math.max(0, Math.min(lifetime, 24 * 60 * 60_000))
    );
    const pending = current.current;
    return () => {
      clearTimeout(timer);
      pending.controller?.abort();
      ++pending.sequence;
    };
  }, [load, grant.expiresAt]);
  return (
    <section
      id="limitedSupportList"
      className="mt-6 space-y-3 rounded border border-owly-border p-4"
      aria-busy={busy}
    >
      <h2 className="text-xl font-semibold">Limited conversation list</h2>
      <p>
        Only conversations covered by this grant are shown. Conversation details are unavailable in
        this view.
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          className={button}
          onClick={() => void load(query.current.page, query.current.search)}
          disabled={busy}
        >
          Refresh list
        </button>
        <button className={button} onClick={onClose}>
          Close list
        </button>
      </div>
      <form
        className="flex flex-wrap gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void load(1, search);
        }}
      >
        <label htmlFor="supportListSearch">Search conversations</label>
        <input
          id="supportListSearch"
          className="rounded border border-owly-border bg-owly-bg p-2"
          maxLength={200}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button className={button} disabled={busy}>
          Search list
        </button>
      </form>
      {busy && <p role="status">Checking support access…</p>}
      {error && <p role="alert">{error}</p>}
      {conflict && (
        <button className={button} onClick={() => void load(1, search, true)} disabled={busy}>
          Clear workspace selection and retry
        </button>
      )}
      {result && (
        <>
          <p role="status">
            {result.pagination.total} conversations · Page {result.pagination.page} of{" "}
            {Math.max(1, result.pagination.totalPages)}
          </p>
          <div
            className="overflow-x-auto"
            role="region"
            aria-label="Limited support conversations"
            tabIndex={0}
          >
            <table className="min-w-[40rem] w-full text-left [&_th]:px-3 [&_th]:py-2 [&_th]:whitespace-nowrap [&_td]:px-3 [&_td]:py-2">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Contact</th>
                  <th>Channel</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((row) => (
                  <tr key={row.id} data-support-conversation={row.id}>
                    <td>{row.customerName || "Unnamed customer"}</td>
                    <td>{row.customerContact || "—"}</td>
                    <td>{row.channel}</td>
                    <td>{row.status}</td>
                    <td>{new Date(row.updatedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!result.data.length && <p>No conversations match this search.</p>}
          <div className="flex gap-3">
            <button
              className={button}
              disabled={busy || result.pagination.page <= 1}
              onClick={() => void load(result.pagination.page - 1, query.current.search)}
            >
              Previous page
            </button>
            <button
              className={button}
              disabled={busy || result.pagination.page >= result.pagination.totalPages}
              onClick={() => void load(result.pagination.page + 1, query.current.search)}
            >
              Next page
            </button>
          </div>
        </>
      )}
    </section>
  );
}
