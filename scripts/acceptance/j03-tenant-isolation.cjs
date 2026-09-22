// PLAN.md acceptance run finding: this journey's attack surface (ticket,
// conversation, customer, knowledge entry/category, webchat connection)
// is only fully exercised once that data exists — created by J04
// (knowledge), J05 (webchat setup) and J08 (ticket via tool execution).
// Run it after those, not in raw numeric order (see run-all.sh).
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
  // If this fires, the journey was run out of order: J04/J05/J08 (and, for a
  // real B-side conversation, J06b) must run before J03 so there is real
  // cross-tenant data to attack, not undefined ids that 404 vacuously.
  for (const field of ["ticket", "conv", "customer", "entry", "category", "webchatConn"]) {
    L.assert(!!idsA[field], `A has a real '${field}' id to attack (run J04/J05/J06/J08/J11 before J03) — got ${idsA[field]}`);
  }
  out["B (logged in as bob) attacking A's IDs"] = await attack("B->A", bp, idsA);
  out["A (logged in as alice) attacking B's IDs"] = await attack("A->B", ap, { ...idsB, conv: idsB.conv || "00000000-0000-0000-0000-000000000001", action: idsB.action });
  // body injection: B creates a ticket claiming A's businessId/id
  const bizA = await ap.evaluate(async () => (await (await fetch("/api/team/members")).json()).data?.[0]?.businessId);
  out.bodyInjection = await bp.evaluate(async (bizA) => { const r = await fetch("/api/tickets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "inject", description: "x", priority: "low", businessId: bizA }) }); return { s: r.status, b: (await r.text()).slice(0, 140) }; }, idsA.ticket || "x");
  // integrity: did any attack change A's data?
  const safe = async (p, url, pick) => { const r = await api(p, "GET", url); try { return pick(JSON.parse(r.b.length < 140 ? r.b : "{}"), r); } catch { return `status=${r.s}`; } };
  const full = (p, url) => p.evaluate(async (url) => { const r = await fetch(url); return { s: r.status, t: await r.text() }; }, url);
  // /api/knowledge/entries/[id] only implements PUT/DELETE (no single-entry GET, confirmed by
  // reading the route) — a GET there 405s for anyone, telling us nothing about the entry's actual
  // content, so integrity is verified the same way a legitimate reader would: via the list endpoint.
  const t = await full(ap, "/api/tickets/" + idsA.ticket); const e = await full(ap, "/api/knowledge/entries"); const c = await full(ap, "/api/conversations/" + idsA.conv); const w = await full(ap, "/api/channels/webchat-connections"); const cat = await full(ap, "/api/knowledge/categories");
  const wJson = (() => { try { return JSON.parse(w.t); } catch { return null; } })();
  out.integrity = {
    A_ticket: `${t.s} title_unchanged=${!/hijacked/.test(t.t)} still_A_title=${/custom cake order|Something is broken/.test(t.t)}`,
    A_entry: `${e.s} intact=${/ZIYRAK-A-CODE-731/.test(e.t)} poisoned=${/poisoned/.test(e.t)}`,
    A_conversation: `${c.s} injected_message_present=${c.t.includes("injected by other tenant")}`,
    A_webchat_origins: wJson && wJson.data && wJson.data[0] ? wJson.data[0].allowedOrigins : "(no webchat connection — J05 must run before J03)",
    A_category: (() => { try { return JSON.parse(cat.t).data.map((x) => x.name); } catch { return []; } })(),
  };
  // UI: B's conversations page must not list A's conversation
  await bp.goto(L.BASE + "/conversations", { waitUntil: "networkidle0" }); await L.sleep(800);
  out.B_conversationsPageMentionsA = /manager|verification code|cake order/i.test(await L.text(bp));
  await L.shot(bp, "j3-B-conversations");

  // Every cross-tenant attempt must be rejected (404/403/401), never succeed.
  for (const direction of ["B (logged in as bob) attacking A's IDs", "A (logged in as alice) attacking B's IDs"]) {
    for (const [label, status] of Object.entries(out[direction])) {
      if (label.startsWith("list ")) continue; // list endpoints 200 by design, scoped to the caller's own rows
      L.assert(![200, 201].includes(status), `${direction}: '${label}' must be rejected, got ${status}`);
    }
  }
  // createTicketSchema has no businessId field at all, so Zod silently strips it before the
  // scoped client ever sees it — the create succeeds (201), but as an ordinary ticket owned by
  // B (the real caller), never as A. The safety property is "not tagged as A", not "rejected".
  L.assert(!out.bodyInjection.b.includes(`"businessId":"${bizA}"`), `a ticket B creates is never tagged with A's businessId regardless of what the body claims, got ${out.bodyInjection.b}`);
  L.assert(out.integrity.A_ticket.includes("title_unchanged=true"), `A's ticket title was not changed by B's attack`);
  L.assert(out.integrity.A_ticket.includes("still_A_title=true"), `A's ticket is still present/intact`);
  L.assert(out.integrity.A_entry.includes("intact=true") && out.integrity.A_entry.includes("poisoned=false"), `A's knowledge entry was not poisoned`);
  L.assert(out.integrity.A_conversation.includes("injected_message_present=false"), `no message was injected into A's conversation`);
  L.assert(Array.isArray(out.integrity.A_webchat_origins) && !out.integrity.A_webchat_origins.includes("https://evil.example"), `A's webchat allowed origins were not overwritten by B, got ${JSON.stringify(out.integrity.A_webchat_origins)}`);
  L.assert(out.B_conversationsPageMentionsA === false, `B's conversations page never shows A's conversation content`);

  L.finish("J03", out);
  await A.close(); await B.close();
})().catch((e) => { console.error("ERR", e); process.exit(1); });
