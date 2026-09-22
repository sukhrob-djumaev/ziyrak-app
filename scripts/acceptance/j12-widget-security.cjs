const L = require("./lib.cjs"); const creds = require("./creds.json"); const fs = require("fs");
const parse = (f) => { const s = fs.readFileSync(f, "utf8"); return { conn: s.match(/data-connection-id="([^"]+)"/)[1], token: s.match(/data-token="([^"]+)"/)[1] }; };
const A = parse(L.SP + "/snippet-A.html"), B = parse(L.SP + "/snippet-B.html");
const OA = "http://localhost:4020", OB = "http://localhost:4021", EVIL = "https://evil.example";
const post = async (conn, token, origin, conversationId, text = "security probe") => {
  const h = { "Content-Type": "application/json" }; if (origin) h.Origin = origin;
  const r = await fetch(`${L.BASE}/api/channels/webchat/${conn}/message`, { method: "POST", headers: h, body: JSON.stringify({ token, conversationId, clientMessageId: crypto.randomUUID(), customerContact: "probe-visitor-" + Math.random().toString(36).slice(2, 8), text }) });
  return { s: r.status, acao: r.headers.get("access-control-allow-origin") };
};
const get = async (path, headers = {}) => { const r = await fetch(L.BASE + path, { headers }); return r.status; };
(async () => {
  const out = { cases: {} }; const c = out.cases;
  const newConv = () => crypto.randomUUID();
  c["CONTROL valid token + connection + allowed origin"] = await post(A.conn, A.token, OA, newConv());
  c["forged token (same connection, right origin)"] = await post(A.conn, "zy_pub_" + "0".repeat(48), OA, newConv());
  c["empty token"] = await post(A.conn, "", OA, newConv());
  c["A's token used on B's connection (B's origin)"] = await post(B.conn, A.token, OB, newConv());
  c["B's token used on A's connection (A's origin)"] = await post(A.conn, B.token, OA, newConv());
  c["A's token+connection but B's site origin"] = await post(A.conn, A.token, OB, newConv());
  c["A's token+connection from evil origin"] = await post(A.conn, A.token, EVIL, newConv());
  c["A's token+connection with NO Origin header"] = await post(A.conn, A.token, null, newConv());
  c["nonexistent connection id"] = await post(crypto.randomUUID(), A.token, OA, newConv());
  // conversation-id reuse across connection/business
  const aConv = (await (async () => { const b = await L.launch(creds.A.profile); const p = await b.newPage(); await p.setExtraHTTPHeaders({ "X-Forwarded-For": "10.0.6.11" }); await p.goto(L.BASE + "/tickets", { waitUntil: "networkidle0" }); const id = await p.evaluate(async () => (await (await fetch("/api/conversations")).json()).data.find((x) => x.status === "escalated").id); await b.close(); return id; })());
  c["B's VALID token/origin writing into A's conversation id"] = await post(B.conn, B.token, OB, aConv, "injected via B widget");
  const pollA = (conn, token, origin, conv, visitor) => fetch(`${L.BASE}/api/channels/webchat/${conn}/messages?token=${encodeURIComponent(token)}&conversationId=${conv}&visitorId=${visitor}`, { headers: { Origin: origin } }).then((r) => r.status);
  c["B's VALID creds READING A's conversation (poll)"] = await pollA(B.conn, B.token, OB, aConv, "any-visitor");
  c["A's VALID creds reading A's conversation with a WRONG visitorId"] = await pollA(A.conn, A.token, OA, aConv, "someone-else");
  c["B's VALID creds subscribing to A's conversation (SSE)"] = await fetch(`${L.BASE}/api/channels/webchat/${B.conn}/stream?token=${B.token}&conversationId=${aConv}`, { headers: { Origin: OB } }).then((r) => r.status);
  // widget credential presented to admin APIs
  const tok = A.token;
  for (const [label, headers] of [["Authorization: Bearer <widget token>", { Authorization: "Bearer " + tok }], ["X-API-Key: <widget token>", { "X-API-Key": tok }], ["Cookie owly-token=<widget token>", { Cookie: "owly-token=" + tok }]]) {
    for (const path of ["/api/conversations", "/api/channels/webchat-connections", "/api/admin/users", "/api/actions"]) c[`${label} -> GET ${path}`] = await get(path, headers);
  }
  // preflight
  const pf = async (origin) => { const r = await fetch(`${L.BASE}/api/channels/webchat/${A.conn}/message`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } }); return `${r.status} acao=${r.headers.get("access-control-allow-origin")}`; };
  c["preflight from allowed origin"] = await pf(OA); c["preflight from evil origin"] = await pf(EVIL); c["preflight from B's origin on A's connection"] = await pf(OB);
  // integrity: nothing was written into A's conversation
  const msgs = L.sql(`select count(*) from "Message" where content in ('injected via B widget','security probe') and "conversationId"='${aConv}';`);
  out.injectedIntoAConversation = msgs;
  // ---- token rotation through the real dashboard UI ----
  const ob = await L.launch(creds.A.profile); const op = await ob.newPage(); await op.setExtraHTTPHeaders({ "X-Forwarded-For": "10.0.6.21" }); op.on("dialog", (d) => d.accept());
  await op.goto(L.BASE + "/channels", { waitUntil: "networkidle0" });
  await L.clickFirst(op, "button", "Rotate token"); await L.sleep(2000);
  const snip = await op.$eval("pre", (e) => e.innerText); fs.writeFileSync(L.SP + "/snippet-A-rotated.html", snip);
  const newTok = snip.match(/data-token="([^"]+)"/)[1];
  await L.shot(op, "j12-A-rotated");
  out.rotation = { tokenChanged: newTok !== A.token, newPrefix: newTok.slice(0, 7), sameConnection: snip.includes(A.conn) };
  c["AFTER ROTATION: old token (right origin)"] = await post(A.conn, A.token, OA, newConv());
  c["AFTER ROTATION: new token"] = await post(A.conn, newTok, OA, newConv());
  c["AFTER ROTATION: B's token unaffected"] = await post(B.conn, B.token, OB, newConv());
  out.rotation.ownerSessionStillValid = await op.evaluate(async () => (await fetch("/api/auth")).status);
  out.rotation.otherChannelsUntouched = await op.evaluate(async () => (await (await fetch("/api/channels")).json()).length);
  await ob.close();
  // Customer site still carrying the OLD snippet: widget must fail visibly; then fixed with the new snippet
  const vb = await L.launch("visitor-rot"); const vctx = await vb.createBrowserContext(); const vp = await vctx.newPage();
  await vp.goto("http://localhost:4020/", { waitUntil: "load" }); await vp.waitForSelector("#ziyrak-input"); await L.sleep(800);
  const stale = await L.widgetSend(vp, "hello from a stale embed", { timeoutMs: 8000 });
  out.staleEmbedWidget = { ack: stale.ack && stale.ack.status, reply: stale.reply, log: stale.log };
  await vctx.close();
  const pageA = fs.readFileSync(L.SP + "/pages/4020.html", "utf8").replace(/<script[^>]*widget\.js[^>]*><\/script>/, snip);
  fs.writeFileSync(L.SP + "/pages/4020.html", pageA);
  const vctx2 = await vb.createBrowserContext(); const vp2 = await vctx2.newPage();
  await vp2.goto("http://localhost:4020/", { waitUntil: "load" }); await vp2.waitForSelector("#ziyrak-input"); await L.sleep(800);
  const fresh = await L.widgetSend(vp2, "What is your verification code?");
  out.freshEmbedWidget = { ack: fresh.ack && fresh.ack.status, reply: fresh.reply };
  await vb.close();

  // Every widget-credential attack must be rejected; only the CONTROL/positive
  // cases below are expected to succeed.
  const mustSucceed = new Set([
    "CONTROL valid token + connection + allowed origin",
    "AFTER ROTATION: new token",
    "AFTER ROTATION: B's token unaffected",
  ]);
  // A documented, accepted product quirk (PLAN.md's browser acceptance record): the message route
  // fast-ACKs (200) before the worker resolves the conversation, so posting with a foreign
  // conversationId still ACKs — the write itself never lands (verified separately below via
  // injectedIntoAConversation), which is the actual safety property here, not the ACK status.
  const ackOnlyNotSafety = new Set(["B's VALID token/origin writing into A's conversation id"]);
  for (const [label, val] of Object.entries(c)) {
    const status = typeof val === "object" && val !== null ? val.s : val;
    if (typeof status !== "number") continue; // preflight strings handled separately below
    if (ackOnlyNotSafety.has(label)) continue;
    if (mustSucceed.has(label)) L.assert([200, 201].includes(status), `'${label}' should succeed, got ${status}`);
    else L.assert(![200, 201].includes(status), `'${label}' must be rejected, got ${status}`);
  }
  L.assert(c["CONTROL valid token + connection + allowed origin"].acao === OA, `CONTROL response carries A's own origin in ACAO, got ${c["CONTROL valid token + connection + allowed origin"].acao}`);
  L.assert(c["preflight from allowed origin"].includes(`acao=${OA}`), `preflight from A's allowed origin reflects it, got ${c["preflight from allowed origin"]}`);
  L.assert(!c["preflight from evil origin"].includes(`acao=${EVIL}`), `preflight from an evil origin never reflects it, got ${c["preflight from evil origin"]}`);
  L.assert(!c["preflight from B's origin on A's connection"].includes(`acao=${OB}`), `preflight from B's origin on A's connection never reflects it, got ${c["preflight from B's origin on A's connection"]}`);
  L.assert(out.injectedIntoAConversation === "0", `nothing was written into A's conversation by any attack, got ${out.injectedIntoAConversation}`);
  L.assert(out.rotation.tokenChanged === true, `token rotation actually changes the token`);
  L.assert(out.rotation.sameConnection === true, `rotation keeps the same connection id`);
  L.assert(out.rotation.ownerSessionStillValid === 200, `the owner's own session survives rotating the widget token, got ${out.rotation.ownerSessionStillValid}`);
  L.assert(out.staleEmbedWidget.ack !== 200, `a stale (pre-rotation) embed is rejected, got ack=${out.staleEmbedWidget.ack}`);
  L.assert(out.staleEmbedWidget.reply === null, `a stale embed never gets a reply, got ${JSON.stringify(out.staleEmbedWidget.reply)}`);
  L.assert(out.freshEmbedWidget.ack === 200, `the freshly rotated embed works, got ack=${out.freshEmbedWidget.ack}`);
  L.assert(!!out.freshEmbedWidget.reply, `the freshly rotated embed gets a reply`);

  L.finish("J12", out);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
