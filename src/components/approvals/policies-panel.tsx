"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { toolLabel } from "@/lib/approvals/present";
import { cn } from "@/lib/utils";

interface Policy {
  enabledForTenant: boolean;
  allowedForAI: boolean;
  allowedForHumanRoles: string[];
  requiresHumanApproval: boolean;
}

interface ToolPolicyRow {
  tool: string;
  description: string;
  customized: boolean;
  policy: Policy;
}

const ROLE_OPTIONS = ["viewer", "agent", "supervisor", "admin", "owner"] as const;

function Switch({ checked, disabled, label, hint, onChange }: { checked: boolean; disabled?: boolean; label: string; hint?: string; onChange: (value: boolean) => void }) {
  return (
    <label className={cn("flex items-start gap-3", disabled ? "opacity-60" : "cursor-pointer")}>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 accent-[var(--owly-primary,#4a7a9b)]"
      />
      <span>
        <span className="block text-sm font-medium text-owly-text">{label}</span>
        {hint && <span className="block text-xs text-owly-text-light">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * Per-tool policy controls (PLAN.md §23.4): is the tool on, may the AI use it,
 * must a human approve it first, and which roles may run it by hand. Each change
 * saves immediately; roles that may only view get read-only controls.
 */
export function PoliciesPanel() {
  const { toast } = useToast();
  const [rows, setRows] = useState<ToolPolicyRow[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tool-policies");
      if (!res.ok) throw new Error(res.status === 403 ? "You don't have access to tool policies." : "Could not load tool policies.");
      const body = await res.json();
      setRows(body.data as ToolPolicyRow[]);
      setCanEdit(body.canEdit === true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load tool policies.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (tool: string, patch: Partial<Policy>) => {
    setSaving(tool);
    try {
      const res = await fetch(`/api/tool-policies/${tool}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : body?.error?.message ?? "Could not save.");
      setRows((prev) => prev.map((r) => (r.tool === tool ? (body as ToolPolicyRow) : r)));
    } catch (e) {
      toast({ type: "error", title: `Could not update ${toolLabel(tool)}`, description: e instanceof Error ? e.message : "Please try again." });
    } finally {
      setSaving(null);
    }
  };

  const reset = async (tool: string) => {
    setSaving(tool);
    try {
      const res = await fetch(`/api/tool-policies/${tool}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? "Could not reset.");
      setRows((prev) => prev.map((r) => (r.tool === tool ? (body as ToolPolicyRow) : r)));
      toast({ type: "success", title: `${toolLabel(tool)} reset to the default` });
    } catch (e) {
      toast({ type: "error", title: `Could not reset ${toolLabel(tool)}`, description: e instanceof Error ? e.message : "Please try again." });
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-owly-primary" />
      </div>
    );
  }
  if (error) return <EmptyState icon={ShieldCheck} title="Tool policies unavailable" description={error} action={{ label: "Try again", onClick: load }} />;

  return (
    <div className="space-y-3" data-testid="policies">
      <p className="text-sm text-owly-text-light">
        Decide what the AI may do on its own. Turn on <strong>Needs human approval</strong> for any tool you want a person to check first — its requests then wait under <em>Waiting</em>.
        {!canEdit && " You can view these settings; only admins and owners can change them."}
      </p>
      {rows.map((row) => {
        const busy = saving === row.tool;
        const readOnly = !canEdit || busy;
        return (
          <section key={row.tool} className="bg-owly-surface border border-owly-border rounded-xl p-5" data-testid="policy-row" data-tool={row.tool}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-owly-text">{toolLabel(row.tool)}</h3>
                  {row.customized && <Badge variant="info">Customised</Badge>}
                  {!row.policy.enabledForTenant && <Badge variant="default">Off</Badge>}
                </div>
                <p className="text-sm text-owly-text-light mt-0.5">{row.description}</p>
              </div>
              {canEdit && row.customized && (
                <button onClick={() => reset(row.tool)} disabled={busy} className="inline-flex items-center gap-1 text-sm text-owly-text-light hover:text-owly-text">
                  <RotateCcw className="h-3.5 w-3.5" /> Reset to default
                </button>
              )}
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Switch label="Available" hint="Turn the tool off for everyone" checked={row.policy.enabledForTenant} disabled={readOnly} onChange={(v) => save(row.tool, { enabledForTenant: v })} />
              <Switch label="AI may use it" hint="Let the AI call it during a conversation" checked={row.policy.allowedForAI} disabled={readOnly} onChange={(v) => save(row.tool, { allowedForAI: v })} />
              <Switch label="Needs human approval" hint="A person approves each AI request first" checked={row.policy.requiresHumanApproval} disabled={readOnly} onChange={(v) => save(row.tool, { requiresHumanApproval: v })} />
            </div>

            <fieldset className="mt-4" disabled={readOnly}>
              <legend className="text-xs font-medium uppercase tracking-wide text-owly-text-light">Team roles that may run it by hand</legend>
              <div className="mt-2 flex flex-wrap gap-4">
                {ROLE_OPTIONS.map((role) => (
                  <label key={role} className={cn("inline-flex items-center gap-2 text-sm text-owly-text", readOnly ? "opacity-60" : "cursor-pointer")}>
                    <input
                      type="checkbox"
                      aria-label={`${role} may run ${toolLabel(row.tool)}`}
                      checked={row.policy.allowedForHumanRoles.includes(role)}
                      onChange={(e) =>
                        save(row.tool, {
                          allowedForHumanRoles: e.target.checked
                            ? [...row.policy.allowedForHumanRoles, role]
                            : row.policy.allowedForHumanRoles.filter((r) => r !== role),
                        })
                      }
                      className="h-4 w-4"
                    />
                    <span className="capitalize">{role}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </section>
        );
      })}
    </div>
  );
}
