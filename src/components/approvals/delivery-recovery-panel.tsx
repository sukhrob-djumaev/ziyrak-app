"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useLiveRefresh } from "@/lib/hooks/use-live-refresh";
interface Row {
  id: string;
  kind: string;
  conversationId: string | null;
  channel: string;
  response: string | null;
  status: string;
  retryable: boolean;
  attempts: number;
  errorMessage: string | null;
  providerMessageId: string | null;
}
type Decision = "confirm_accepted" | "cancel" | "resend";
const labels: Record<string, string> = {
  unknown: "Send outcome uncertain",
  preparation_interrupted: "Reply needs review",
  rejected: "Send refused",
  ready: "Saved reply waiting",
};
export function DeliveryRecoveryPanel() {
  const [rows, setRows] = useState<Row[]>([]),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Row | null>(null),
    [decision, setDecision] = useState<Decision>("cancel");
  const [reason, setReason] = useState(""),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [requestId, setRequestId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/deliveries");
      if (!res.ok)
        throw new Error(
          res.status === 403
            ? "Delivery recovery requires a supervisor, admin or owner."
            : "Could not load delivery recovery."
        );
      const body = await res.json();
      setRows(body.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load recovery.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(
    () => {
      void load();
    },
    { intervalMs: 15_000 }
  );
  function choose(row: Row) {
    setSelected(row);
    setDecision("cancel");
    setReason("");
    setAck(false);
    setRequestId(crypto.randomUUID());
    setNotice(null);
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    try {
      const res = await fetch("/api/deliveries/" + selected.id + "/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reason, acknowledgeDuplicateRisk: ack, requestId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? "The decision could not be saved.");
      setNotice(
        decision === "resend"
          ? "Decision saved. The saved reply is queued; acceptance is still pending."
          : "Decision saved."
      );
      setSelected(null);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "The decision could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <p>Loading delivery recovery…</p>;
  if (error)
    return (
      <div role="alert">
        <p>{error}</p>
        <button onClick={() => void load()}>Try again</button>
      </div>
    );
  return (
    <section aria-label="Delivery recovery" className="space-y-4">
      <p className="text-sm text-owly-text-light">
        Review replies that could not be confirmed. Provider acceptance does not confirm that the
        customer received a message.
      </p>
      {notice && <p role="status">{notice}</p>}
      {rows.length === 0 ? (
        <p>No replies need recovery.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li
              key={row.id}
              data-testid="delivery-recovery-row"
              className="bg-owly-surface border border-owly-border rounded-xl p-5 space-y-2"
            >
              <h3 className="font-semibold">
                {row.kind === "followup" ? "Scheduled follow-up" : "Customer reply"} ·{" "}
                {labels[row.status] ?? "Needs review"}
              </h3>
              <p className="text-sm">{row.errorMessage}</p>
              {row.providerMessageId && (
                <p className="text-sm">
                  Provider reference: <code>{row.providerMessageId}</code>
                </p>
              )}
              {row.response !== null && (
                <blockquote className="whitespace-pre-wrap max-h-48 overflow-auto">
                  {row.response}
                </blockquote>
              )}
              {row.status === "preparation_interrupted" && (
                <p>
                  Review completed AI actions before replying manually. Automatic processing remains
                  stopped.
                </p>
              )}
              <div className="flex gap-4">
                {row.conversationId && (
                  <Link
                    className="text-owly-primary hover:underline"
                    href={"/conversations?id=" + row.conversationId}
                  >
                    View conversation
                  </Link>
                )}
                <button className="text-owly-primary font-medium" onClick={() => choose(row)}>
                  Review recovery
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <form
          onSubmit={submit}
          className="border border-owly-border rounded-xl p-5 space-y-3"
          aria-label="Recovery decision"
        >
          <label className="block">
            Decision
            <select
              aria-label="Recovery decision"
              className="block p-2 bg-owly-surface border rounded"
              value={decision}
              onChange={(e) => {
                setDecision(e.target.value as Decision);
                setRequestId(crypto.randomUUID());
              }}
            >
              <option value="cancel">Stop this reply</option>
              {selected.status === "unknown" && (
                <option value="confirm_accepted">Confirm provider acceptance from evidence</option>
              )}
              {selected.response !== null && <option value="resend">Send the saved reply</option>}
            </select>
          </label>
          {decision === "resend" && selected.status === "unknown" && (
            <label className="block text-sm">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I
              understand the previous request may have succeeded and sending again can create a
              duplicate.
            </label>
          )}
          <label className="block">
            Reason
            <textarea
              aria-label="Recovery reason"
              required
              minLength={5}
              maxLength={500}
              className="block w-full p-2 bg-owly-surface border rounded"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setRequestId(crypto.randomUUID());
              }}
            />
          </label>
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={
                busy ||
                reason.trim().length < 5 ||
                (decision === "resend" && selected.status === "unknown" && !ack)
              }
              className="px-4 py-2 rounded bg-owly-primary text-white disabled:opacity-50"
            >
              Save recovery decision
            </button>
            <button type="button" disabled={busy} onClick={() => setSelected(null)}>
              Back
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
