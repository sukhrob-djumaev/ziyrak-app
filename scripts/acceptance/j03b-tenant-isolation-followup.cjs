const L = require("./lib.cjs"); const creds = require("./creds.json");
const call = (p, m, url, body) => p.evaluate(async (m, url, body) => { const r = await fetch(url, { method: m, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }); return `${r.status} ${(await r.text()).slice(0, 70).replace(/\s+/g, " ")}`; }, m, url, body);
(async () => {
  const A = await L.launch(creds.A.profile); const ap = await A.newPage(); await ap.setExtraHTTPHeaders({ "X-Forwarded-For": "10.0.5.11" }); await ap.goto(L.BASE + "/tickets", { waitUntil: "networkidle0" });
  const B = await L.launch(creds.B.profile); const bp = await B.newPage(); await bp.setExtraHTTPHeaders({ "X-Forwarded-For": "10.0.5.12" }); await bp.goto(L.BASE + "/tickets", { waitUntil: "networkidle0" });
  const conv = await ap.evaluate(async () => (await (await fetch("/api/conversations")).json()).data.find((c) => c.status === "escalated").id);
  const cust = await ap.evaluate(async () => (await (await fetch("/api/customers")).json()).data[0].id);
  const conn = await ap.evaluate(async () => (await (await fetch("/api/channels/webchat-connections")).json()).data[0].connectionId);
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
  console.log(JSON.stringify(out, null, 1)); L.log({ journey: 3, phase: "redo-missed-probes", out });
  await A.close(); await B.close();
})().catch((e) => { console.error("ERR", e); process.exit(1); });
