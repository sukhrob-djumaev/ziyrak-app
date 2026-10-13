"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, MessageSquare, ShieldCheck, XCircle } from "lucide-react";
import { Header } from "@/components/layout/header";
import { Badge } from "@/components/ui/badge";
import { PoliciesPanel } from "@/components/approvals/policies-panel";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { useLiveRefresh } from "@/lib/hooks/use-live-refresh";
import { requesterLabel, statusPresentation, summarizeInput, timeAgo, toolLabel } from "@/lib/approvals/present";
import { cn } from "@/lib/utils";

interface ActionRow {
  id: string;
  tool: string;
  status: string;
  input: unknown;
  result: { message?: string } | null;
  conversationId: string | null;
  requestedBy: string;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

type Tab = "pending" | "history" | "policies";
type Decision = { action: ActionRow; kind: "approve" | "reject" } | null;

const POLL_MS = 15_000;

export default function ApprovalsPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("pending");
  const [pending, setPending] = useState<ActionRow[]>([]);
  const [history, setHistory] = useState<ActionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const [pendingRes, allRes] = await Promise.all([
        fetch("/api/actions?status=pending_approval&limit=50"),
        fetch("/api/actions?limit=50"),
      ]);
      if (pendingRes.status === 403 || allRes.status === 403) {
        setForbidden(true);
        return;
      }
      if (!pendingRes.ok || !allRes.ok) throw new Error("Could not load approvals.");
      const pendingBody = await pendingRes.json();
      const allBody = await allRes.json();
      setPending(pendingBody.data as ActionRow[]);
      setHistory((allBody.data as ActionRow[]).filter((a) => a.status !== "pending_approval"));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load approvals.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // A new approval request or a decision by someone else shows up without a manual refresh.
  useLiveRefresh(load, { intervalMs: POLL_MS });

  const decide = async () => {
    if (!decision) return;
    const { action, kind } = decision;
    try {
      const res = await fetch(`/api/actions/${action.id}/${kind}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        toast({ type: "info", title: "Already handled", description: "Someone else already decided on this request." });
      } else if (!res.ok) {
        toast({ type: "error", title: `Could not ${kind}`, description: body?.error?.message ?? "Please try again." });
      } else if (kind === "reject") {
        toast({ type: "success", title: "Rejected", description: "The action was not run." });
      } else if (body.success === false) {
        toast({ type: "error", title: "Approved, but the action failed", description: body.message });
      } else {
        toast({ type: "success", title: "Approved and run", description: body.message });
      }
    } catch {
      toast({ type: "error", title: `Could not ${kind}`, description: "Network error. Please try again." });
    } finally {
      setDecision(null);
      load();
    }
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rows = tab === "pending" ? pending : history;

  return (
    <>
      <Header title="Approvals" description="Review actions the AI wants to take before they run" />

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        <div className="flex items-center gap-2" role="tablist">
          {(["pending", "history", "policies"] as const).map((key) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                tab === key ? "bg-owly-primary text-white" : "bg-owly-surface border border-owly-border text-owly-text-light hover:text-owly-text"
              )}
            >
              {key === "pending" ? `Waiting (${pending.length})` : key === "history" ? "History" : "Policies"}
            </button>
          ))}
        </div>

        {tab === "policies" ? (
          <PoliciesPanel />
        ) : loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-owly-primary" />
          </div>
        ) : forbidden ? (
          <EmptyState icon={ShieldCheck} title="You don't have access to approvals" description="Reviewing AI actions needs a supervisor, admin or owner role." />
        ) : loadError ? (
          <EmptyState icon={XCircle} title="Could not load approvals" description={loadError} action={{ label: "Try again", onClick: load }} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={tab === "pending" ? CheckCircle2 : ShieldCheck}
            title={tab === "pending" ? "Nothing is waiting for approval" : "No actions yet"}
            description={tab === "pending" ? "When the AI wants to run an action that needs a human decision, it will appear here." : "Actions the AI has requested will be listed here."}
          />
        ) : (
          <ul className="space-y-3" data-testid={`approvals-${tab}`}>
            {rows.map((action) => {
              const status = statusPresentation(action.status);
              const fields = summarizeInput(action.input);
              const open = expanded.has(action.id);
              return (
                <li key={action.id} className="bg-owly-surface border border-owly-border rounded-xl p-5" data-testid="approval-row">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-owly-text">{toolLabel(action.tool)}</h3>
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </div>
                      <p className="text-sm text-owly-text-light">
                        Requested by {requesterLabel(action.requestedBy)} · {timeAgo(action.createdAt)}
                        {action.conversationId && (
                          <>
                            {" · "}
                            <Link href={`/conversations?id=${action.conversationId}`} className="inline-flex items-center gap-1 text-owly-primary hover:underline">
                              <MessageSquare className="h-3.5 w-3.5" /> View conversation
                            </Link>
                          </>
                        )}
                      </p>
                    </div>

                    {action.status === "pending_approval" && (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setDecision({ action, kind: "reject" })}
                          className="px-3 py-2 rounded-lg border border-owly-border text-sm font-medium text-owly-text hover:bg-owly-bg"
                        >
                          Reject
                        </button>
                        <button
                          onClick={() => setDecision({ action, kind: "approve" })}
                          className="px-3 py-2 rounded-lg bg-owly-primary text-white text-sm font-medium hover:opacity-90"
                        >
                          Approve
                        </button>
                      </div>
                    )}
                  </div>

                  {fields.length > 0 && (
                    <div className="mt-3">
                      <button onClick={() => toggle(action.id)} className="inline-flex items-center gap-1 text-sm text-owly-text-light hover:text-owly-text">
                        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        {open ? "Hide details" : "Show details"}
                      </button>
                      {open && (
                        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                          {fields.map((field) => (
                            <div key={field.key} className="contents">
                              <dt className="text-owly-text-light">{field.key}</dt>
                              <dd className="text-owly-text break-words">{field.value || "—"}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </div>
                  )}

                  {(action.errorMessage || action.result?.message) && action.status !== "pending_approval" && (
                    <p className={cn("mt-3 text-sm", action.status === "failed" ? "text-owly-danger" : "text-owly-text-light")}>
                      {action.errorMessage ?? action.result?.message}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={decision !== null}
        onCancel={() => setDecision(null)}
        onConfirm={decide}
        destructive={decision?.kind === "reject"}
        title={decision?.kind === "approve" ? `Approve "${decision ? toolLabel(decision.action.tool) : ""}"?` : `Reject "${decision ? toolLabel(decision.action.tool) : ""}"?`}
        description={
          decision?.kind === "approve"
            ? "This runs the action now. Check the details first — it may send messages or change data."
            : "The action will not run and cannot be restarted from here."
        }
        confirmLabel={decision?.kind === "approve" ? "Approve and run" : "Reject"}
      />
    </>
  );
}
