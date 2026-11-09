"use client";

import { useCallback, useEffect, useState } from "react";
import { Header } from "@/components/layout/header";
import { LoadFailed } from "@/components/ui/load-failed";

interface Status {
  providerEnabled: boolean;
  hold: { held: boolean; retentionEndsAt: string | null };
  subscription: { status: string; currentPeriodEnd: string | null; graceEndsAt: string | null; currency: string; items: { versionId: string; name: string; kind: string; quantity: number; state: string; pendingQuantity: number | null; effectiveAt: string | null }[] } | null;
  suspendedMembers: { membershipId: string; role: string; name: string; email: string | null }[];
  sellable: { versionId: string; itemKey: string; kind: string; name: string; description: string; priceMinor: number | null; currency: string | null; interval: string | null }[];
}
interface Quote { totalMinor: number; currency: string; interval: string; quotedAt: string; quoteHash: string; lines: { versionId: string; name: string; quantity: number; unitMinor: number }[] }
interface SeatConflict { members: number; openInvitations: number; newLimit: number; effectiveAt: string; chosen: string[] | null; people: { membershipId: string; role: string; name: string; email: string | null }[] }

interface Offer {
  purchases: { id: string; itemKey: string; kind: string; name: string; version: number; quantity: number; source: string }[];
  capabilities: { key: string; label: string; kind: string; granted: boolean; limit: number | null; sources: string[] }[];
  seats: { members: number; openInvitations: number; limit: number };
  adjustments: { capability: string; expiresAt: string }[];
  aiAllowance: { status: string; generation: { used: number; reserved: number; limit: number }; embedding: { used: number; reserved: number; limit: number }; resetsAt: string; note: string } | null;
  availableAddons: { itemKey: string; name: string; description: string; priceMinor: number | null; currency: string | null; interval: string | null }[];
  note: string;
}

const sourceLabel: Record<string, string> = { baseline: "included with your workspace", manual_test: "added by the platform team", provider: "subscription" };

const money = (minor: number, currency: string | null) => `${(minor / 100).toFixed(2)} ${currency ?? ""}`.trim();
const statusText: Record<string, string> = {
  incomplete: "Waiting for your payment to be confirmed",
  active: "Active",
  past_due: "Payment failed - still working while we retry",
  canceling: "Ends at the close of the paid period",
  ended: "Ended",
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? "Something went wrong. Try again.");
  return body as T;
}

/** Owner picks who keeps a seat when a scheduled team-size decrease applies. Renders nothing for a package that grants no seats. */
function SeatChoice({ versionId, onError }: { versionId: string; onError: (m: string | null) => void }) {
  const [c, setC] = useState<SeatConflict | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api<SeatConflict>(`/api/billing/change/seats?versionId=${versionId}`)
      .then((r) => {
        setC(r);
        setPicked(new Set(r.chosen ?? r.people.filter((p) => p.role === "owner").map((p) => p.membershipId)));
        setSaved(r.chosen !== null);
      })
      .catch(() => setC(null));
  }, [versionId]);
  if (!c) return null;
  const room = c.newLimit - c.openInvitations;
  const toggle = (id: string) => { setSaved(false); setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); };
  const save = async () => {
    onError(null);
    try {
      await api("/api/billing/change/seats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ versionId, membershipIds: [...picked] }) });
      setSaved(true);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <fieldset className="mt-2 rounded border p-2" data-testid="seat-choice">
      <legend className="px-1 text-xs">Who keeps a seat from {new Date(c.effectiveAt).toLocaleDateString()} (room for {room})</legend>
      {c.people.map((p) => (
        <label key={p.membershipId} className="flex items-center gap-2">
          <input type="checkbox" checked={picked.has(p.membershipId)} disabled={p.role === "owner"} onChange={() => toggle(p.membershipId)} />
          <span>{p.name || p.email || "Member"} <span className="text-ziyrak-text-light">({p.role})</span></span>
        </label>
      ))}
      <button type="button" className="mt-1 rounded border px-2 py-1" disabled={picked.size > room} data-testid="save-stayers" onClick={save}>Save choice</button>
      {saved && <span role="status" className="ml-2 text-xs">Saved. Nobody loses access before that date.</span>}
      {picked.size > room && <span className="ml-2 text-xs text-red-700">Choose at most {room}.</span>}
    </fieldset>
  );
}

/** Change an active subscription: raise a quantity (priced and confirmed before any charge) or schedule a reduction for the period end. */
function ChangePlan({ status, busy, run, refresh, onError }: { status: Status; busy: boolean; run: (fn: () => Promise<void>) => Promise<void>; refresh: () => Promise<void>; onError: (m: string | null) => void }) {
  const sub = status.subscription!;
  const held = new Map(sub.items.map((i) => [i.versionId, i]));
  const addons = status.sellable.filter((v) => v.kind === "addon");
  const [target, setTarget] = useState<Record<string, number>>({});
  const [quote, setQuote] = useState<(Quote & { lines: { versionId: string; name: string; quantity: number; unitMinor: number }[] }) | null>(null);
  const [lines, setLines] = useState<{ versionId: string; quantity: number }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const jsonPost = <T,>(url: string, body: unknown) => api<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const changed = addons.map((v) => ({ v, want: target[v.versionId] ?? held.get(v.versionId)?.quantity ?? 0, have: held.get(v.versionId)?.quantity ?? 0 })).filter((r) => r.want !== r.have);
  const ups = changed.filter((r) => r.want > r.have).map((r) => ({ versionId: r.v.versionId, quantity: r.want }));
  const downs = changed.filter((r) => r.want < r.have).map((r) => ({ versionId: r.v.versionId, quantity: r.want }));
  const done = async (msg: string) => { setQuote(null); setTarget({}); setNotice(msg); await refresh(); };

  return (
    <div className="mt-4" data-testid="change-plan">
      <h3 className="font-medium">Change your add-ons</h3>
      {notice && <p role="status" className="mt-1 text-xs" data-testid="change-notice">{notice}</p>}
      <ul className="mt-1 space-y-2">
        {addons.map((v) => {
          const it = held.get(v.versionId);
          const scheduled = it?.state === "scheduled_remove";
          return (
            <li key={v.versionId} data-testid="change-row">
              <label className="flex items-center gap-2">
                <span className="w-48">{v.name} <span className="text-ziyrak-text-light">{v.priceMinor !== null && `${money(v.priceMinor, v.currency)}/${v.interval}`}</span></span>
                <input type="number" min={0} max={1000} aria-label={`${v.name} quantity`} className="w-16 rounded border px-1" disabled={busy || scheduled}
                  value={target[v.versionId] ?? it?.quantity ?? 0} onChange={(e) => { setQuote(null); setTarget((t) => ({ ...t, [v.versionId]: Math.max(0, Math.min(1000, Math.floor(Number(e.target.value) || 0))) })); }} />
              </label>
              {scheduled && it && (
                <p className="ml-1 text-xs" data-testid="scheduled">
                  Goes down to {it.pendingQuantity} on {it.effectiveAt && new Date(it.effectiveAt).toLocaleDateString()}; you keep it until then.{" "}
                  <button type="button" className="underline" disabled={busy} onClick={() => run(async () => { await jsonPost("/api/billing/change/unschedule", { versionId: v.versionId }); await done("The reduction is cancelled."); })}>Keep it</button>
                  <SeatChoice versionId={v.versionId} onError={onError} />
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {ups.length > 0 && !quote && (
        <button type="button" disabled={busy} className="mt-2 rounded border px-3 py-1.5" data-testid="quote-upgrade"
          onClick={() => run(async () => { setLines(ups); setQuote(await jsonPost("/api/billing/change/quote", { lines: ups })); })}>Review price</button>
      )}
      {quote && (
        <div className="mt-2" data-testid="upgrade-quote">
          <p>Adds <span className="font-medium">{money(quote.totalMinor, quote.currency)}/{quote.interval}</span>. It starts once the payment is confirmed.</p>
          <button type="button" disabled={busy} className="mt-1 rounded bg-ziyrak-primary-fill px-3 py-1.5 text-white" data-testid="apply-upgrade"
            onClick={() => run(async () => { const r = await jsonPost<{ confirmed: boolean }>("/api/billing/change", { lines, quoteHash: quote.quoteHash, quotedAt: quote.quotedAt }); await done(r.confirmed ? "Your add-ons are updated." : "Waiting for the payment to be confirmed."); })}>Confirm and pay</button>
        </div>
      )}
      {downs.length > 0 && (
        <button type="button" disabled={busy} className="mt-2 ml-2 rounded border px-3 py-1.5" data-testid="schedule-reduction"
          onClick={() => run(async () => { const r = await jsonPost<{ effectiveAt: string }>("/api/billing/change/schedule", { lines: downs }); await done(`Scheduled for ${new Date(r.effectiveAt).toLocaleDateString()}. You keep everything until then.`); })}>Reduce at the end of the paid period</button>
      )}
    </div>
  );
}

/** Subscribe, see the subscription, and manage payment details. Returning from checkout grants nothing; it waits for the confirmed subscription. */
function Subscription() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api<Status>("/api/billing/status"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    refresh();
    if (new URLSearchParams(window.location.search).get("checkout") !== "return") return;
    setConfirming(true);
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      await refresh();
      if (tries >= 20) {
        clearInterval(timer);
        setConfirming(false);
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (status?.subscription && status.subscription.status !== "incomplete") setConfirming(false);
  }, [status]);

  const lines = Object.entries(cart).filter(([, q]) => q > 0).map(([versionId, quantity]) => ({ versionId, quantity }));
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const post = (url: string, body?: unknown) => api<{ url: string } & Quote>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  if (!status) return error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null;
  const sub = status.subscription;
  return (
    <section aria-labelledby="sub" data-testid="subscription">
      <h2 id="sub" className="text-lg font-semibold text-ziyrak-text">Subscription</h2>
      {status.hold.held && (
        <p role="status" data-testid="hold-note" className="mt-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          Your workspace is paused. New messages are saved, but nothing is answered until you subscribe again.
          {status.hold.retentionEndsAt && ` Your data is kept until ${new Date(status.hold.retentionEndsAt).toLocaleDateString()}.`}
        </p>
      )}
      {confirming && <p role="status" data-testid="confirming" className="mt-2 text-sm">Confirming your payment. This usually takes under a minute.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      {sub ? (
        <div className="mt-2 text-sm" data-testid="sub-state">
          <p><span className="font-medium">{statusText[sub.status] ?? sub.status}</span>
            {sub.currentPeriodEnd && ` - paid period ends ${new Date(sub.currentPeriodEnd).toLocaleDateString()}`}
            {sub.status === "past_due" && sub.graceEndsAt && `. Update your payment method before ${new Date(sub.graceEndsAt).toLocaleDateString()} or the workspace will be paused.`}
          </p>
          <ul className="mt-1">{sub.items.map((i, n) => <li key={n}>{i.name}{i.quantity > 1 ? ` ×${i.quantity}` : ""}</li>)}</ul>
          {status.suspendedMembers.length > 0 && (
            <div className="mt-3" data-testid="suspended-members">
              <h3 className="font-medium">Members without a seat</h3>
              <p className="text-xs text-ziyrak-text-light">They cannot sign in until a seat is free. Their data is kept.</p>
              <ul className="mt-1">
                {status.suspendedMembers.map((m) => (
                  <li key={m.membershipId} className="flex items-center gap-2">
                    <span>{m.name || m.email || "Member"} <span className="text-ziyrak-text-light">({m.role})</span></span>
                    <button type="button" disabled={busy} className="rounded border px-2 py-0.5" data-testid="restore-member"
                      onClick={() => run(async () => { await api("/api/billing/change/restore-member", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ membershipId: m.membershipId }) }); await refresh(); })}>Give a seat back</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {sub.status === "active" && <ChangePlan status={status} busy={busy} run={run} refresh={refresh} onError={setError} />}
          <button type="button" disabled={busy} className="mt-2 rounded border px-3 py-1.5" data-testid="open-portal"
            onClick={() => run(async () => { window.location.assign((await post("/api/billing/portal")).url); })}>Manage payment details</button>
        </div>
      ) : status.providerEnabled ? (
        <div className="mt-2 text-sm">
          <ul className="space-y-2" data-testid="sellable">
            {status.sellable.map((v) => (
              <li key={v.versionId}>
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={(cart[v.versionId] ?? 0) > 0} disabled={busy}
                    onChange={(e) => { setQuote(null); setCart((c) => ({ ...c, [v.versionId]: e.target.checked ? 1 : 0 })); }} />
                  <span><span className="font-medium">{v.name}</span> - {v.priceMinor === null ? "price not set" : `${money(v.priceMinor, v.currency)}/${v.interval}`}<br /><span className="text-ziyrak-text-light">{v.description}</span></span>
                </label>
                {v.kind === "addon" && (cart[v.versionId] ?? 0) > 0 && (
                  <label className="ml-6 text-xs">Quantity <input type="number" min={1} max={1000} value={cart[v.versionId]} className="w-16 rounded border px-1"
                    onChange={(e) => { setQuote(null); setCart((c) => ({ ...c, [v.versionId]: Math.max(1, Math.floor(Number(e.target.value) || 1)) })); }} /></label>
                )}
              </li>
            ))}
            {status.sellable.length === 0 && <li className="text-ziyrak-text-light">Nothing is available to buy right now.</li>}
          </ul>
          {!quote ? (
            <button type="button" disabled={busy || lines.length === 0} className="mt-3 rounded border px-3 py-1.5" data-testid="get-quote"
              onClick={() => run(async () => setQuote(await post("/api/billing/quote", { lines })))}>Review price</button>
          ) : (
            <div className="mt-3" data-testid="quote">
              <p>Total: <span className="font-medium">{money(quote.totalMinor, quote.currency)}/{quote.interval}</span>. You are sent to our payment partner to pay; nothing is active until the payment is confirmed.</p>
              <button type="button" disabled={busy} className="mt-2 rounded bg-ziyrak-primary-fill px-3 py-1.5 text-white" data-testid="start-checkout"
                onClick={() => run(async () => { window.location.assign((await post("/api/billing/checkout", { lines, quoteHash: quote.quoteHash, quotedAt: quote.quotedAt })).url); })}>Continue to payment</button>
            </div>
          )}
        </div>
      ) : (
        <p className="mt-2 text-sm text-ziyrak-text-light">Online payment is not available for this deployment.</p>
      )}
    </section>
  );
}

/** The owner's read-only view of the package: what is included, where it comes from, and how much is used. */
export default function BillingPage() {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const load = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch("/api/billing/offer", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setOffer(await res.json());
      setState("ready");
    } catch {
      setState("failed");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <Header title="Plan & usage" description="What your workspace includes and how much of it is in use." />
      <div className="flex-1 overflow-y-auto p-4 md:p-6 max-w-3xl space-y-6" data-testid="billing-view">
        {state === "loading" && <p className="text-sm text-ziyrak-text-light">Loading your plan…</p>}
        {state === "failed" && <LoadFailed what="your plan" onRetry={load} />}
        {state === "ready" && offer && (
          <>
            <Subscription />
            <section aria-labelledby="held">
              <h2 id="held" className="text-lg font-semibold text-ziyrak-text">Your package</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {offer.purchases.map((p) => (
                  <li key={p.id} data-testid="purchase">
                    <span className="font-medium">{p.name}</span> <span className="text-ziyrak-text-light">({p.kind}, version {p.version}{p.quantity > 1 ? `, ×${p.quantity}` : ""}) – {sourceLabel[p.source] ?? p.source}</span>
                  </li>
                ))}
                {offer.purchases.length === 0 && <li>No package is active for this workspace. Contact the platform team.</li>}
              </ul>
            </section>
            <section aria-labelledby="caps">
              <h2 id="caps" className="text-lg font-semibold text-ziyrak-text">What is included</h2>
              <table className="mt-2 w-full text-left text-sm" aria-label="Included features">
                <tbody>
                  {offer.capabilities.map((c) => (
                    <tr key={c.key} data-capability={c.key}>
                      <td className="py-1 pr-4">{c.label}</td>
                      <td className="py-1">{c.kind === "limit" ? (c.granted ? `Up to ${c.limit}` : "Not included") : c.granted ? "Included" : "Not included"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section aria-labelledby="seats">
              <h2 id="seats" className="text-lg font-semibold text-ziyrak-text">Team seats</h2>
              <p className="mt-1 text-sm" data-testid="seat-usage">{offer.seats.members} members and {offer.seats.openInvitations} open invitations of {offer.seats.limit} seats.</p>
            </section>
            {offer.aiAllowance && (
              <section aria-labelledby="ai">
                <h2 id="ai" className="text-lg font-semibold text-ziyrak-text">AI use this period</h2>
                <p className="mt-1 text-sm">Replies: {offer.aiAllowance.generation.used.toLocaleString()} of {offer.aiAllowance.generation.limit.toLocaleString()} tokens. Knowledge search: {offer.aiAllowance.embedding.used.toLocaleString()} of {offer.aiAllowance.embedding.limit.toLocaleString()} tokens. Resets {new Date(offer.aiAllowance.resetsAt).toLocaleDateString()}.</p>
                <p className="text-xs text-ziyrak-text-light">{offer.aiAllowance.note}</p>
              </section>
            )}
            {offer.adjustments.length > 0 && (
              <section aria-labelledby="adj">
                <h2 id="adj" className="text-lg font-semibold text-ziyrak-text">Temporary additions</h2>
                <ul className="mt-1 text-sm">{offer.adjustments.map((a, i) => <li key={i}>{a.capability} until {new Date(a.expiresAt).toLocaleDateString()} (added by the platform team)</li>)}</ul>
              </section>
            )}
            <section aria-labelledby="addons">
              <h2 id="addons" className="text-lg font-semibold text-ziyrak-text">Available add-ons</h2>
              <ul className="mt-1 space-y-1 text-sm" data-testid="addons">
                {offer.availableAddons.map((a) => (
                  <li key={a.itemKey}><span className="font-medium">{a.name}</span> – {a.priceMinor === null ? "price not set" : `${(a.priceMinor / 100).toFixed(2)} ${a.currency}/${a.interval}`} <span className="text-ziyrak-text-light">{a.description}</span></li>
                ))}
                {offer.availableAddons.length === 0 && <li className="text-ziyrak-text-light">None right now.</li>}
              </ul>
              <p className="mt-2 text-xs text-ziyrak-text-light">{offer.note}</p>
            </section>
          </>
        )}
      </div>
    </>
  );
}
