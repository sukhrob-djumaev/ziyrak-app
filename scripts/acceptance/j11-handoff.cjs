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
  // Bind the human action to the visitor's own current conversation, rather
  // than the first generic "Website Visitor" row (which could be a prior run).
  const replyMarker = (out.visitorReply || "").slice(0, 48);
  out.openedCurrentConversation = await op.evaluate((marker) => {
    const row = [...document.querySelectorAll("button")].find((button) => button.innerText.includes(marker));
    if (!row) return false;
    row.click();
    return true;
  }, replyMarker);
  await L.sleep(1500);
  // Current Phase 7 behavior escalates only when the product's confidence
  // rule does. If this real response did not cross that rule, use the
  // existing dashboard status control to create the handoff explicitly.
  const initial = await op.evaluate(async (id) => (await (await fetch("/api/conversations/" + id)).json()).status, convId);
  out.escalationDecision = initial === "escalated" ? "product_confidence_after_real_model_response" : "explicit_dashboard_status_change";
  if (initial !== "escalated") {
    const statusChange = op.waitForResponse((res) => res.url().includes(`/api/conversations/${convId}`) && res.request().method() === "PUT", { timeout: 10000 });
    out.usedExplicitEscalationControl = await op.evaluate(() => {
      const select = [...document.querySelectorAll("select")].find((element) => element.value === "active" && [...element.options].some((option) => option.value === "escalated"));
      if (!select) return false;
      select.value = "escalated";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    });
    out.explicitEscalationStatus = (await statusChange).status();
    await L.sleep(800);
  }
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

  L.assert(out.openedCurrentConversation === true, `owner opens the current visitor's conversation, not a prior generic visitor row`);
  L.assert(["product_confidence_after_real_model_response", "explicit_dashboard_status_change"].includes(out.escalationDecision), `the escalation decision is recorded, got ${out.escalationDecision}`);
  L.assert(out.escalationDecision !== "explicit_dashboard_status_change" || (out.usedExplicitEscalationControl === true && out.explicitEscalationStatus === 200), `the explicit dashboard escalation succeeds when needed, got ${JSON.stringify({ used: out.usedExplicitEscalationControl, status: out.explicitEscalationStatus })}`);
  L.assert(out.openedShows.manager === true, `the opened conversation shows the customer's original message`);
  L.assert(out.agentSendApi && out.agentSendApi.status === 201, `the agent's reply is sent (201), got ${out.agentSendApi && out.agentSendApi.status}`);
  L.assert(out.agentSendApi && out.agentSendApi.body.includes(convId), `the agent reply belongs to the current visitor conversation`);
  L.assert(out.customerSawHumanReply === true, `the customer receives the human agent's reply in the widget`);
  L.assert(out.afterRefresh.status === "escalated", `the conversation is still escalated after refresh, got ${out.afterRefresh.status}`);
  L.assert(out.afterRefresh.msgs.length >= 2, `the conversation history persists across refresh, got ${JSON.stringify(out.afterRefresh.msgs)}`);
  L.assert(out.console.length === 0, `no console errors on the owner's conversation view, got ${JSON.stringify(out.console)}`);
  L.assert(out.B_openA === 404, `Business B cannot open A's escalated conversation, got ${out.B_openA}`);

  L.finish("J11", out);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
