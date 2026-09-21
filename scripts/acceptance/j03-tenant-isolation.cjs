const L = require("./lib.cjs"); const creds = require("./creds.json");
const api = (p, method, url, body) => p.evaluate(async (method, url, body) => { const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }); let t = ""; try { t = await r.text(); } catch {} return { s: r.status, b: t.slice(0, 140) }; }, method, url, body);
async function harvest(p) {
  const h = {};
  h.ticket = (await p.evaluate(async () => (await (await fetch("/api/tickets")).json()).data[0]?.id));
  h.conv = (await p.evaluate(async () => (await (await fetch("/api/conversations?limit=100")).json()).data.find((c) => c.status === "escalated")?.id || (await (await fetch("/api/conversations")).json()).data[0]?.id));
  h.customer = (await p.evaluate(async () => (await (await fetch("/api/customers")).json()).data[0]?.id));
  h.entry = (await p.evaluate(async () => (await (await fetch("/api/knowledge/entries")).json()).data[0]?.id));
  h.category = (await p.evaluate(async () => (await (await fetch("/api/knowledge/categories")).json()).data[0]?.id));
  h.webchatConn = (await p.evaluate(async () => (await (await fetch("/api/channels/webchat-connections")).json()).data[0]?.connectionId));
  h.action = (await p.evaluate(async () => (await (await fetch("/api/actions")).json()).data[0]?.id)) || "00000000-0000-0000-0000-000000000000";
  return h;
}
async function attack(name, p, victim) {
  const V = victim; const r = {};
  const cases = [
    ["GET ticket", "GET", `/api/tickets/${V.ticket}`], ["PUT ticket", "PUT", `/api/tickets/${V.ticket}`, { title: "hijacked" }], ["DELETE ticket", "DELETE", `/api/tickets/${V.ticket}`],
    ["GET conversation", "GET", `/api/conversations/${V.conv}`], ["POST reply into conversation", "POST", `/api/conversations/${V.conv}/messages`, { content: "injected by other tenant", role: "assistant" }],
    ["POST transfer conversation", "POST", `/api/conversations/${V.conv}/transfer`, { teamMemberId: "x" }], ["GET conv notes", "GET", `/api/conversations/${V.conv}/notes`],
    ["GET customer", "GET", `/api/customers/${V.customer}`], ["GET customer gdpr export", "GET", `/api/customers/${V.customer}/gdpr/export`], ["DELETE customer gdpr", "POST", `/api/customers/${V.customer}/gdpr/delete`, {}],
    ["GET knowledge entry", "GET", `/api/knowledge/entries/${V.entry}`], ["PUT knowledge entry", "PUT", `/api/knowledge/entries/${V.entry}`, { content: "poisoned" }], ["DELETE knowledge entry", "DELETE", `/api/knowledge/entries/${V.entry}`],
    ["PUT knowledge category", "PUT", `/api/knowledge/categories/${V.category}`, { name: "hijacked" }], ["DELETE knowledge category", "DELETE", `/api/knowledge/categories/${V.category}`],
    ["PUT webchat connection origins", "PUT", `/api/channels/webchat-connections/${V.webchatConn}`, { allowedOrigins: ["https://evil.example"] }], ["ROTATE other tenant's widget token", "POST", `/api/channels/webchat-connections/${V.webchatConn}/rotate-token`, {}],
    ["APPROVE other tenant's action", "POST", `/api/actions/${V.action}/approve`, {}], ["REJECT other tenant's action", "POST", `/api/actions/${V.action}/reject`, {}],
    ["realtime subscribe to other tenant's conversation channel", "GET", `/api/realtime?channel=conversation:${V.conv}`],
  ];
  for (const [label, m, url, body] of cases) r[label] = (await api(p, m, url, body)).s;
  // query/body ID injection: list endpoints must ignore attacker-chosen tenant params
  r["list tickets ?businessId=<victim>"] = await p.evaluate(async () => { const j = await (await fetch("/api/tickets?businessId=other")).json(); return `200 rows=${(j.data || []).length}`; });
  return r;
}
(async () => {
  const out = {};
  const A = await L.launch(creds.A.profile); const ap = await A.newPage(); await ap.setExtraHTTPHeaders({ "X-Forwarded-For": "10.0.4.11" }); await ap.goto(L.BASE + "/tickets", { waitUntil: "networkidle0" });
  const B = await L.launch(creds.B.profile); const bp = await B.newPage(); await bp.setExtraHTTPHeaders({ "X-Forwarded-For": "10.0.4.12" }); await bp.goto(L.BASE + "/tickets", { waitUntil: "networkidle0" });
  // Give B a ticket & conversation-worthy data so the reverse attack has IDs
  await bp.evaluate(async () => { await fetch("/api/tickets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "B's own ticket", description: "b", priority: "low" }) }); });
  const idsA = await harvest(ap); const idsB = await harvest(bp);
  out.idsFound = { A: Object.fromEntries(Object.entries(idsA).map(([k, v]) => [k, !!v])), B: Object.fromEntries(Object.entries(idsB).map(([k, v]) => [k, !!v])) };
  out["B (logged in as bob) attacking A's IDs"] = await attack("B->A", bp, idsA);
  out["A (logged in as alice) attacking B's IDs"] = await attack("A->B", ap, { ...idsB, conv: idsB.conv || "00000000-0000-0000-0000-000000000001", action: idsB.action });
  // body injection: B creates a ticket claiming A's businessId/id
  const bizA = await ap.evaluate(async () => (await (await fetch("/api/team/members")).json()).data?.[0]?.businessId);
  out.bodyInjection = await bp.evaluate(async (bizA) => { const r = await fetch("/api/tickets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "inject", description: "x", priority: "low", businessId: bizA }) }); return { s: r.status, b: (await r.text()).slice(0, 140) }; }, idsA.ticket || "x");
  // integrity: did any attack change A's data?
  const safe = async (p, url, pick) => { const r = await api(p, "GET", url); try { return pick(JSON.parse(r.b.length < 140 ? r.b : "{}"), r); } catch { return `status=${r.s}`; } };
  const full = (p, url) => p.evaluate(async (url) => { const r = await fetch(url); return { s: r.status, t: await r.text() }; }, url);
  const t = await full(ap, "/api/tickets/" + idsA.ticket); const e = await full(ap, "/api/knowledge/entries/" + idsA.entry); const c = await full(ap, "/api/conversations/" + idsA.conv); const w = await full(ap, "/api/channels/webchat-connections"); const cat = await full(ap, "/api/knowledge/categories");
  out.integrity = {
    A_ticket: `${t.s} title_unchanged=${!/hijacked/.test(t.t)} still_A_title=${/custom cake order|Something is broken/.test(t.t)}`,
    A_entry: `${e.s} intact=${/ZIYRAK-A-CODE-731/.test(e.t)} poisoned=${/poisoned/.test(e.t)}`,
    A_conversation: `${c.s} injected_message_present=${c.t.includes("injected by other tenant")}`,
    A_webchat_origins: JSON.parse(w.t).data[0].allowedOrigins,
    A_category: JSON.parse(cat.t).data.map((x) => x.name),
  };
  // UI: B's conversations page must not list A's conversation
  await bp.goto(L.BASE + "/conversations", { waitUntil: "networkidle0" }); await L.sleep(800);
  out.B_conversationsPageMentionsA = /manager|verification code|cake order/i.test(await L.text(bp));
  await L.shot(bp, "j3-B-conversations");
  console.log(JSON.stringify(out, null, 1)); L.log({ journey: 3, ...out });
  await A.close(); await B.close();
})().catch((e) => { console.error("ERR", e); process.exit(1); });
