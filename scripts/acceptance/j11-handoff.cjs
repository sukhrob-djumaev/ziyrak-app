const L = require("./lib.cjs"); const creds = require("./creds.json");
(async () => {
  const out = {};
  const vb = await L.launch("visitor-j11"); const vctx = await vb.createBrowserContext(); const vp = await vctx.newPage();
  await vp.goto("http://localhost:4020/", { waitUntil: "load" }); await vp.waitForSelector("#ziyrak-input"); await L.sleep(800);
  const r = await L.widgetSend(vp, "I want to speak to a manager about a complaint.");
  out.visitorReply = r.reply;
  const convId = await vp.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith("ziyrak_webchat_conversation_"))[1]);
  out.conversationId = convId;
  await L.sleep(500);
  // Owner A in the dashboard (separate browser profile)
  const ob = await L.launch(creds.A.profile); const op = await ob.newPage(); await op.setExtraHTTPHeaders({ "X-Forwarded-For": "10.0.3.11" }); const ev = L.watch(op, "ownerA");
  await op.goto(L.BASE + "/conversations", { waitUntil: "networkidle0" }); await L.sleep(800);
  // filter to Escalated via the real status filter
  const filtered = await op.evaluate(() => { const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.text.trim() === "Escalated")); if (!sel) return false; sel.value = [...sel.options].find((o) => o.text.trim() === "Escalated").value; sel.dispatchEvent(new Event("change", { bubbles: true })); return true; });
  out.usedStatusFilter = filtered; await L.sleep(1500);
  await L.shot(op, "j11-A-escalated-list");
  out.escalatedRows = (await L.text(op)).replace(/\n+/g, " | ").split("Search conversations...").pop().slice(0, 260);
  // open the first escalated conversation
  out.rowCount = await op.evaluate(() => [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && (e.innerText || "").trim() === "Website Visitor").length);
  await op.evaluate(() => { const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && (e.innerText || "").trim() === "Website Visitor"); el.click(); }); await L.sleep(1500);
  await L.shot(op, "j11-A-conversation-open");
  const opened = (await L.text(op)).replace(/\n+/g, " | ");
  out.openedShows = { manager: opened.includes("speak to a manager"), aiTeamMember: /team member/.test(opened) };
  const reply = "Hi, this is Alice from Northwind Bakery. I'm sorry about that, I will personally look into your complaint today.";
  await op.type("textarea[placeholder^='Type your reply']", reply);
  const sendRespP = op.waitForResponse((res) => res.url().includes("/messages") && res.request().method() === "POST", { timeout: 15000 });
  await op.evaluate(() => { const b = [...document.querySelectorAll("button")].find((b) => b.querySelector("svg.lucide-send")); b && b.click(); });
  const sendResp = await sendRespP.catch(() => null);
  out.agentSendApi = sendResp ? { status: sendResp.status(), body: (await sendResp.text()).slice(0, 220) } : null;
  await L.sleep(1200); await L.shot(op, "j11-A-after-reply");
  // customer receives it in the widget (poll)
  let got = false; for (let i = 0; i < 20 && !got; i++) { got = (await vp.$$eval("#ziyrak-log > div", (ds) => ds.map((d) => d.textContent))).some((t) => t.includes("personally look into your complaint")); if (!got) await L.sleep(1000); }
  out.customerSawHumanReply = got;
  // refresh: state persists
  await op.reload({ waitUntil: "networkidle0" }); await L.sleep(1000);
  const api = await op.evaluate(async (id) => { const j = await (await fetch("/api/conversations/" + id)).json(); return { status: j.status, msgs: (j.messages || []).map((m) => m.role + ": " + m.content.slice(0, 40)) }; }, convId);
  out.afterRefresh = api;
  out.console = [...new Set(ev.consoleErrors)];
  await ob.close(); await vb.close();
  // Business B's owner cannot open it
  const bb = await L.launch(creds.B.profile); const bp = await bb.newPage(); await bp.setExtraHTTPHeaders({ "X-Forwarded-For": "10.0.3.12" }); await bp.goto(L.BASE + "/conversations", { waitUntil: "networkidle0" });
  out.B_openA = await bp.evaluate(async (id) => (await fetch("/api/conversations/" + id)).status, convId);
  await bb.close();
  console.log(JSON.stringify(out, null, 1)); L.log({ journey: 11, ...out });
})().catch((e) => { console.error("ERR", e); process.exit(1); });
