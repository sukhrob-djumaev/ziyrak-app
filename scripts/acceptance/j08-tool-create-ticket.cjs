const L = require("./lib.cjs"); const creds = require("./creds.json");
(async () => {
  const out = {};
  const vb = await L.launch("visitor-a-tool"); const vctx = await vb.createBrowserContext(); const vp = await vctx.newPage();
  await vp.goto("http://localhost:4020/", { waitUntil: "load" }); await vp.waitForSelector("#ziyrak-input"); await L.sleep(800);
  out.visitor = await L.widgetSend(vp, "Something is broken: my custom cake order arrived damaged. Please open a ticket for me.");
  delete out.visitor.log;
  await vb.close();
  // Owner (Business A) looks at the dashboard in a separate browser profile
  const ob = await L.launch(creds.A.profile); const op = await ob.newPage(); await op.setExtraHTTPHeaders({ "X-Forwarded-For": L.XFF.A }); const ev = L.watch(op, "owner-A");
  await op.goto(L.BASE + "/tickets", { waitUntil: "networkidle0" }); await L.sleep(800);
  out.ownerTicketsPage = (await L.text(op)).replace(/\n+/g, " | ").split("Tickets |").pop().slice(0, 300);
  await L.shot(op, "j8-A-tickets");
  out.ticketsApi = await op.evaluate(async () => (await (await fetch("/api/tickets")).json()).data.map((t) => ({ title: t.title, priority: t.priority, status: t.status, conversationId: t.conversationId ? "set" : null })));
  out.actionsApi = await op.evaluate(async () => (await (await fetch("/api/actions")).json()));
  await L.shot(op, "j8-A-tickets");
  out.console = [...new Set(ev.consoleErrors)];
  await ob.close();
  // Business B's owner must not see A's ticket
  const bb = await L.launch(creds.B.profile); const bp = await bb.newPage(); await bp.setExtraHTTPHeaders({ "X-Forwarded-For": L.XFF.B });
  await bp.goto(L.BASE + "/tickets", { waitUntil: "networkidle0" });
  out.B_ticketsApi = await bp.evaluate(async () => (await (await fetch("/api/tickets")).json()).data.length);
  out.B_actionsApi = await bp.evaluate(async () => { const j = await (await fetch("/api/actions")).json(); return (j.data || []).length; });
  await bb.close();

  L.assert(out.visitor.ack && out.visitor.ack.status === 200, `visitor ACK is 200, got ${out.visitor.ack && out.visitor.ack.status}`);
  L.assert(out.visitor.reply && /ticket created/i.test(out.visitor.reply), `visitor gets a ticket-created confirmation, got ${JSON.stringify(out.visitor.reply)}`);
  L.assert(out.ticketsApi.length >= 1, `A's dashboard sees the ticket`);
  L.assert(out.ticketsApi[0].priority === "high", `the ticket carries the priority the tool call requested, got ${out.ticketsApi[0].priority}`);
  L.assert(out.ticketsApi[0].conversationId === "set", `the ticket is linked back to its conversation`);
  const action = out.actionsApi.data.find((a) => a.tool === "create_ticket");
  L.assert(action && action.status === "succeeded", `the create_ticket ActionExecution succeeded, got ${action && action.status}`);
  L.assert(action && action.requestedBy === "ai", `the action is attributed to the AI, got ${action && action.requestedBy}`);
  L.assert(out.B_ticketsApi === 0, `Business B sees none of A's tickets, got ${out.B_ticketsApi}`);
  L.assert(out.B_actionsApi === 0, `Business B sees none of A's actions, got ${out.B_actionsApi}`);
  L.assert(out.console.length === 0, `no console errors on the owner's tickets page, got ${JSON.stringify(out.console)}`);

  L.finish("J08", out);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
