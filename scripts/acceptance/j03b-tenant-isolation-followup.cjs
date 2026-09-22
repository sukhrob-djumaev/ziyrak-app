// A continuation of J03's cross-tenant attack matrix that specifically needs
// an ESCALATED conversation for Business A — only J11 (handoff) produces one.
// Run this after J11 (see run-all.sh), not in raw numeric order.
const L = require("./lib.cjs"); const creds = require("./creds.json");
const call = (p, m, url, body) => p.evaluate(async (m, url, body) => { const r = await fetch(url, { method: m, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }); return `${r.status} ${(await r.text()).slice(0, 70).replace(/\s+/g, " ")}`; }, m, url, body);
(async () => {
  const A = await L.launch(creds.A.profile); const ap = await A.newPage(); await ap.setExtraHTTPHeaders({ "X-Forwarded-For": "10.0.5.11" }); await ap.goto(L.BASE + "/tickets", { waitUntil: "networkidle0" });
  const B = await L.launch(creds.B.profile); const bp = await B.newPage(); await bp.setExtraHTTPHeaders({ "X-Forwarded-For": "10.0.5.12" }); await bp.goto(L.BASE + "/tickets", { waitUntil: "networkidle0" });
  const convs = await ap.evaluate(async () => (await (await fetch("/api/conversations")).json()).data);
  const escalated = (convs || []).find((c) => c.status === "escalated");
  if (!escalated) {
    console.error("PRECONDITION FAILED: Business A has no escalated conversation yet. Run J11 (handoff) before J03b.");
    process.exit(1);
  }
  const conv = escalated.id;
  const custRows = await ap.evaluate(async () => (await (await fetch("/api/customers")).json()).data);
  if (!custRows || !custRows.length) { console.error("PRECONDITION FAILED: Business A has no customer yet. Run J06/J08/J11 before J03b."); process.exit(1); }
  const cust = custRows[0].id;
  const connRows = await ap.evaluate(async () => (await (await fetch("/api/channels/webchat-connections")).json()).data);
  if (!connRows || !connRows.length) { console.error("PRECONDITION FAILED: Business A has no webchat connection yet. Run J05 before J03b."); process.exit(1); }
  const conn = connRows[0].connectionId;
  const out = {};
  out["B: HARD gdpr-delete A's customer (with body)"] = await call(bp, "DELETE", `/api/customers/${cust}/gdpr/delete`, { hardDelete: true });
  out["B: gdpr-export A's customer"] = (await call(bp, "GET", `/api/customers/${cust}/gdpr/export`)).slice(0, 60);
  out["B: transfer A's conversation (correct body)"] = await call(bp, "POST", `/api/conversations/${conv}/transfer`, { toMemberId: "any" });
  out["B: add note on A's conversation"] = (await call(bp, "POST", `/api/conversations/${conv}/notes`, { content: "x" })).slice(0, 60);
  // Positive control: the same calls by the legitimate owner do work (proves the 404s above are tenancy, not broken routes)
  out["CONTROL A: PATCH own webchat connection (same origins)"] = await call(ap, "PATCH", `/api/channels/webchat-connections/${conn}`, { allowedOrigins: ["http://localhost:4020"] });
  out["CONTROL A: GET own conversation"] = (await call(ap, "GET", `/api/conversations/${conv}`)).slice(0, 3);
  out["A customer still present (legit owner GET)"] = (await call(ap, "GET", `/api/customers/${cust}`)).slice(0, 3);
  out["A conversation still escalated & intact"] = await ap.evaluate(async (id) => { const j = await (await fetch("/api/conversations/" + id)).json(); return `${j.status}, ${j.messages.length} msgs`; }, conv);
  out["A origins after B's PATCH attempt"] = await ap.evaluate(async () => JSON.stringify((await (await fetch("/api/channels/webchat-connections")).json()).data[0].allowedOrigins));

  // A known, previously-documented product quirk (PLAN.md's browser acceptance record): a
  // cross-tenant GDPR hard-delete answers 200 {success:false,...}, not 404 — never fixed because
  // nothing is actually deleted (deletedRecords:0). The safety property is "no records deleted",
  // not the status code.
  L.assert(/"success":false/.test(out["B: HARD gdpr-delete A's customer (with body)"]) && /"deletedRecords":0/.test(out["B: HARD gdpr-delete A's customer (with body)"]), `B's hard-delete of A's customer deletes nothing, got ${out["B: HARD gdpr-delete A's customer (with body)"]}`);
  L.assert(out["B: gdpr-export A's customer"].startsWith("404"), `B cannot export A's customer via GDPR export, got ${out["B: gdpr-export A's customer"]}`);
  // transferConversation() looks up toMemberId through the SAME scoped client used everywhere else
  // (getScopedPrisma(ctx).teamMember.findUnique) — a foreign id (or, as here, any id not in B's own
  // tenant) resolves to null and returns false → 400 "Transfer failed", never a successful transfer.
  L.assert(!/"success":\s*true/.test(out["B: transfer A's conversation (correct body)"]) && !out["B: transfer A's conversation (correct body)"].startsWith("200"), `B's transfer attempt never succeeds, got ${out["B: transfer A's conversation (correct body)"]}`);
  L.assert(out["B: add note on A's conversation"].startsWith("404"), `B cannot add a note to A's conversation, got ${out["B: add note on A's conversation"]}`);
  L.assert(out["CONTROL A: PATCH own webchat connection (same origins)"].startsWith("200"), `CONTROL: A can PATCH its own webchat connection, got ${out["CONTROL A: PATCH own webchat connection (same origins)"]}`);
  L.assert(out["CONTROL A: GET own conversation"].startsWith("200"), `CONTROL: A can GET its own conversation, got ${out["CONTROL A: GET own conversation"]}`);
  L.assert(out["A customer still present (legit owner GET)"].startsWith("200"), `A's customer is still present after B's attack, got ${out["A customer still present (legit owner GET)"]}`);
  L.assert(out["A conversation still escalated & intact"].startsWith("escalated,"), `A's conversation is still escalated and unmodified, got ${out["A conversation still escalated & intact"]}`);
  L.assert(!out["A origins after B's PATCH attempt"].includes("evil"), `A's webchat origins were not tampered with, got ${out["A origins after B's PATCH attempt"]}`);

  L.finish("J03b", out);
  await A.close(); await B.close();
})().catch((e) => { console.error("ERR", e); process.exit(1); });
