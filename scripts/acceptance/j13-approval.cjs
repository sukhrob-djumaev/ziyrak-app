const L = require("./lib.cjs"); const creds = require("./creds.json"); const { execSync } = require("child_process");
const sql = L.sql;
const BIZB = `(select id from "Business" where name='Volt Electric Scooters')`;
const tickets = () => Number(sql(`select count(*) from "Ticket" where "businessId"=${BIZB}`));
const call = (p, m, url, body) => p.evaluate(async (m, url, body) => { const r = await fetch(url, { method: m, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, j }; }, m, url, body);
async function askTicket(text) { const b = await L.launch("visitor-j13"); const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.goto("http://localhost:4021/", { waitUntil: "load" }); await p.waitForSelector("#ziyrak-input"); await L.sleep(800); const r = await L.widgetSend(p, text); await b.close(); return r.reply; }
(async () => {
  const out = {};
  sql(`update "ToolPolicy" set "requiresHumanApproval"=true where tool='create_ticket' and "businessId"=${BIZB};`);
  out.policy = sql(`select tool||' allowedForAI='||"allowedForAI"||' requiresHumanApproval='||"requiresHumanApproval" from "ToolPolicy" where tool='create_ticket' and "businessId"=${BIZB};`);
  const t0 = tickets();
  out.aiReply1 = await askTicket("Something is broken with my scooter battery. Please open a ticket.");
  const pend = sql(`select id||' | '||status||' | requestedBy='||"requestedBy" from "ActionExecution" where tool='create_ticket' and "businessId"=${BIZB} order by "createdAt" desc limit 1;`);
  out.pendingAction = pend; const id1 = pend.split(" | ")[0];
  out.ticketsWhilePending = `${t0} -> ${tickets()} (no side effect while pending)`;
  // owner (browser session) sees it in the API list
  const ob = await L.launch(creds.B.profile); const op = await ob.newPage(); await op.setExtraHTTPHeaders({ "X-Forwarded-For": "10.0.7.11" }); await op.goto(L.BASE + "/tickets", { waitUntil: "networkidle0" });
  out.ownerSeesPending = (await call(op, "GET", "/api/actions?status=pending_approval")).j.data.map((a) => `${a.tool}:${a.status}`);
  // a viewer (created by the owner) logs in through the real UI and tries to approve -> denied
  out.createViewer = (await call(op, "POST", "/api/admin/users", { username: "viewer_b", password: "Viewer-Pass-2026!", name: "Vera Viewer", role: "viewer" })).s;
  const vb = await L.launch("viewer-b"); const vp = await vb.newPage(); await vp.setExtraHTTPHeaders({ "X-Forwarded-For": "10.0.7.31" });
  await vp.goto(L.BASE + "/login", { waitUntil: "networkidle0" }); await vp.type("input#username,input[name=username]", "viewer_b"); await vp.type("input[type=password]", "Viewer-Pass-2026!"); await L.clickFirst(vp, "button", "Sign In"); await vp.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 10000 }).catch(() => {}); await L.sleep(800);
  out.viewerLoggedInAs = (await call(vp, "GET", "/api/auth")).j.user?.username;
  out.viewerApprove = (await call(vp, "POST", `/api/actions/${id1}/approve`, {})).s; out.viewerReject = (await call(vp, "POST", `/api/actions/${id1}/reject`, {})).s;
  out.stillPendingAfterViewer = sql(`select status from "ActionExecution" where id='${id1}';`); await vb.close();
  // owner approves (authenticated production API; no UI exists for this step)
  const ap = await call(op, "POST", `/api/actions/${id1}/approve`, {}); out.ownerApprove = ap.s;
  await L.sleep(500);
  out.afterApprove = { status: sql(`select status from "ActionExecution" where id='${id1}';`), tickets: tickets(), ticketLinked: sql(`select count(*) from "Ticket" where "businessId"=${BIZB} and title like '%scooter battery%';`) };
  out.approveAgain = (await call(op, "POST", `/api/actions/${id1}/approve`, {})).s; out.ticketsAfterSecondApprove = tickets();
  // rejection path
  out.aiReply2 = await askTicket("Something is broken: the scooter brakes are failing. Open a ticket please.");
  const id2 = sql(`select id from "ActionExecution" where tool='create_ticket' and status='pending_approval' and "businessId"=${BIZB} order by "createdAt" desc limit 1;`);
  const t2 = tickets(); const rej = await call(op, "POST", `/api/actions/${id2}/reject`, { reason: "not needed" }); out.ownerReject = rej.s; await L.sleep(400);
  out.afterReject = { status: sql(`select status from "ActionExecution" where id='${id2}';`), tickets: `${t2} -> ${tickets()}` }; out.approveAfterReject = (await call(op, "POST", `/api/actions/${id2}/approve`, {})).s;
  out.activity = sql(`select action from "ActivityLog" where "businessId"=${BIZB} and (action like 'action.%' or action like 'tool.%') order by "createdAt";`).split("\n");
  sql(`update "ToolPolicy" set "requiresHumanApproval"=false where tool='create_ticket' and "businessId"=${BIZB};`);
  console.log(JSON.stringify(out, null, 1)); L.log({ journey: 13, ...out }); await ob.close();
})().catch((e) => { console.error("ERR", e); process.exit(1); });
