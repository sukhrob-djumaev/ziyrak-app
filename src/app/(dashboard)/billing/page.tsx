"use client";

import { useCallback, useEffect, useState } from "react";
import { Header } from "@/components/layout/header";
import { LoadFailed } from "@/components/ui/load-failed";

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
