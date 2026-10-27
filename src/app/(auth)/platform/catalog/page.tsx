"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Version = {
  id: string;
  itemId: string;
  version: number;
  state: "draft" | "published" | "archived";
  rev: number;
  name: string;
  description: string;
  grants: { capability: string; amount?: number }[];
  priceMinor: number | null;
  currency: string | null;
  interval: "month" | "year" | null;
  problems: string[];
};
type Item = { id: string; key: string; kind: "bundle" | "addon"; versions: Version[] };
type Console = { capabilities: { key: string; label: string; kind: string }[]; items: Item[] };

const field = "w-full rounded border border-ziyrak-border bg-ziyrak-bg p-2";
const cell = "pr-4 py-1 align-top";
const button = "rounded bg-ziyrak-primary px-3 py-1.5 text-white disabled:opacity-50";
const money = (v: Version) => (v.priceMinor === null ? "No price" : `${(v.priceMinor / 100).toFixed(2)} ${v.currency ?? ""} / ${v.interval ?? ""}`);

export default function CatalogPage() {
  const router = useRouter();
  const [data, setData] = useState<Console | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // Form state: editing a draft (versionId set) or creating an item.
  const [editing, setEditing] = useState<{ versionId: string; rev: number; key: string } | null>(null);
  const [key, setKey] = useState("");
  const [kind, setKind] = useState("bundle");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [interval, setInterval] = useState("month");
  const [granted, setGranted] = useState<string[]>([]);
  const [reason, setReason] = useState("");

  async function load() {
    const response = await fetch("/api/platform/catalog", { cache: "no-store" });
    if (response.status === 401) return router.replace("/login");
    if (response.status === 403) {
      setData(null);
      return setDenied(true);
    }
    if (!response.ok) throw new Error("Could not load the catalog. Try again.");
    setData(await response.json());
    setDenied(false);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function mutate(payload: object, success: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/platform/catalog", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (response.status === 401) {
        router.replace("/login");
        return false;
      }
      const body = await response.json();
      if (!response.ok) {
        const details = Array.isArray(body.error?.details) ? ` ${body.error.details.join(" ")}` : "";
        throw new Error((body.error?.message || "The change could not be saved") + details);
      }
      await load();
      setMessage(success);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "The change could not be saved");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const terms = () => ({
    name,
    description,
    grants: granted.map((capability) => ({ capability })),
    priceMinor: price.trim() === "" ? null : Math.round(Number(price) * 100),
    currency: price.trim() === "" ? null : currency.trim().toUpperCase(),
    interval: price.trim() === "" ? null : interval,
  });

  function startEdit(item: Item, v: Version) {
    setEditing({ versionId: v.id, rev: v.rev, key: item.key });
    setName(v.name);
    setDescription(v.description);
    setGranted(v.grants.map((g) => g.capability));
    setPrice(v.priceMinor === null ? "" : String(v.priceMinor / 100));
    setCurrency(v.currency ?? "USD");
    setInterval(v.interval ?? "month");
    setReason("");
  }
  function clearForm() {
    setEditing(null);
    setKey("");
    setName("");
    setDescription("");
    setPrice("");
    setGranted([]);
    setReason("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = editing
      ? await mutate({ action: "save_draft", versionId: editing.versionId, expectedRev: editing.rev, terms: terms(), reason }, "Draft saved.")
      : await mutate({ action: "create_item", key, kind, terms: terms(), reason }, "Draft created.");
    if (ok) clearForm();
  }

  return (
    <section className="rounded-2xl border border-ziyrak-border bg-ziyrak-surface p-6 shadow-lg">
      <h1 className="text-2xl font-bold">Offer catalog</h1>
      {denied ? (
        <p role="alert" className="mt-4">Access denied. Super admin authority is required.</p>
      ) : !data ? (
        <p role="status" className="mt-4">{error ? "The catalog is unavailable." : "Loading…"}</p>
      ) : (
        <>
          <p className="mt-3">
            Bundles and add-ons grant capabilities the product already implements. A published version never changes; a new price or
            content is a new version. Prices here are display values: no payment is collected yet.
          </p>
          {error && <p role="alert">{error}</p>}
          {message && <p role="status">{message}</p>}

          <h2 className="mt-6 text-xl font-semibold">Items</h2>
          {data.items.length === 0 && <p>No items yet. Create the first below.</p>}
          {data.items.map((item) => (
            <div key={item.id} className="mt-4" data-item-key={item.key}>
              <h3 className="font-semibold">{item.key} <span className="text-sm font-normal">({item.kind})</span></h3>
              <table className="mt-1 w-full table-auto text-left text-sm" aria-label={`Versions of ${item.key}`}>
                <thead>
                  <tr><th className={cell}>Version</th><th className={cell}>State</th><th className={cell}>Name</th><th className={cell}>Grants</th><th className={cell}>Price</th><th className={cell}>Actions</th></tr>
                </thead>
                <tbody>
                  {item.versions.map((v) => (
                    <tr key={v.id} data-version={v.version}>
                      <td className={cell}>{v.version}</td>
                      <td className={cell}>{v.state}</td>
                      <td className={cell}>{v.name}</td>
                      <td className={cell}>{v.grants.map((g) => g.capability).join(", ") || "none"}</td>
                      <td className={cell}>{money(v)}</td>
                      <td className={cell}>
                        {v.state === "draft" && (
                          <>
                            <button className={button} disabled={busy} onClick={() => startEdit(item, v)}>Edit draft {v.version}</button>{" "}
                            <button className={button} disabled={busy || v.problems.length > 0} onClick={() => mutate({ action: "publish", versionId: v.id, expectedRev: v.rev, reason: `Publish ${item.key} v${v.version}` }, "Version published.")}>Publish {v.version}</button>
                            {v.problems.length > 0 && <ul className="text-xs">{v.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
                          </>
                        )}
                        {v.state === "published" && (
                          <>
                            <button className={button} disabled={busy} onClick={() => mutate({ action: "archive", versionId: v.id, reason: `Archive ${item.key} v${v.version}` }, "Version archived.")}>Archive {v.version}</button>{" "}
                            {!item.versions.some((x) => x.state === "draft") && v.version === Math.max(...item.versions.filter((x) => x.state === "published").map((x) => x.version)) && (
                              <button className={button} disabled={busy} onClick={() => mutate({ action: "new_draft", itemId: item.id, reason: `New version of ${item.key}` }, "New draft created.")}>New version</button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          <h2 className="mt-8 text-xl font-semibold">{editing ? `Edit draft of ${editing.key}` : "Create item"}</h2>
          <form onSubmit={submit} className="mt-2 grid max-w-xl gap-3">
            {!editing && (
              <>
                <label htmlFor="cat-key">Key (lowercase, hyphens)</label>
                <input id="cat-key" className={field} value={key} onChange={(e) => setKey(e.target.value)} required />
                <label htmlFor="cat-kind">Kind</label>
                <select id="cat-kind" className={field} value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="bundle">Bundle (base package)</option>
                  <option value="addon">Add-on</option>
                </select>
              </>
            )}
            <label htmlFor="cat-name">Name</label>
            <input id="cat-name" className={field} value={name} onChange={(e) => setName(e.target.value)} required />
            <label htmlFor="cat-desc">Description</label>
            <textarea id="cat-desc" className={field} value={description} onChange={(e) => setDescription(e.target.value)} />
            <fieldset>
              <legend>Capabilities granted</legend>
              {data.capabilities.map((c) => (
                <label key={c.key} className="mr-4 inline-flex items-center gap-2">
                  <input type="checkbox" checked={granted.includes(c.key)} onChange={(e) => setGranted((g) => (e.target.checked ? [...g, c.key] : g.filter((x) => x !== c.key)))} />
                  {c.label}
                </label>
              ))}
            </fieldset>
            <label htmlFor="cat-price">Price (display value; blank = not priced yet)</label>
            <input id="cat-price" className={field} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
            <label htmlFor="cat-currency">Currency (3 letters)</label>
            <input id="cat-currency" className={field} value={currency} onChange={(e) => setCurrency(e.target.value)} />
            <label htmlFor="cat-interval">Billing interval</label>
            <select id="cat-interval" className={field} value={interval} onChange={(e) => setInterval(e.target.value)}>
              <option value="month">Monthly</option>
              <option value="year">Yearly</option>
            </select>
            <label htmlFor="cat-reason">Reason (recorded in the audit)</label>
            <input id="cat-reason" className={field} value={reason} onChange={(e) => setReason(e.target.value)} required />
            <div>
              <button type="submit" className={button} disabled={busy}>{editing ? "Save draft" : "Create draft"}</button>{" "}
              {editing && <button type="button" className={button} onClick={clearForm}>Cancel</button>}
            </div>
          </form>
        </>
      )}
    </section>
  );
}
