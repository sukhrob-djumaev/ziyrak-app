const L = require("./lib.cjs"); const creds = require("./creds.json"); const { execSync } = require("child_process");
const sql = L.sql;
const BIZB = `(select id from "Business" where name='Volt Electric Scooters')`;
const tickets = () => Number(sql(`select count(*) from "Ticket" where "businessId"=${BIZB}`));
const call = (p, m, url, body) => p.evaluate(async (m, url, body) => { const r = await fetch(url, { method: m, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, j }; }, m, url, body);
async function askTicket(text) { const b = await L.launch("visitor-j13"); const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.goto("http://localhost:4021/", { waitUntil: "load" }); await p.waitForSelector("#ziyrak-input"); await L.sleep(800); const r = await L.widgetSend(p, text); await b.close(); return r.reply; }
// L3.1 / D10: policy and the owner's decisions go through the real Approvals UI; only the viewer's denied attempts stay API-level.
const openTab = async (p, prefix) => {
  await p.waitForSelector('[role="tab"]');
  const ok = await p.evaluate((prefix) => { const t = [...document.querySelectorAll('[role="tab"]')].find((e) => e.innerText.trim().startsWith(prefix)); if (!t) return false; t.click(); return true; }, prefix);
  if (!ok) throw new Error(`no tab '${prefix}'`);
};
async function setApprovalPolicyViaUi(op, on) {
  await op.goto(L.BASE + "/approvals", { waitUntil: "networkidle0" });
  await openTab(op, "Policies");
  const sw = '[data-testid="policy-row"][data-tool="create_ticket"] input[aria-label="Needs human approval"]';
  await op.waitForSelector(sw);
  if ((await op.$eval(sw, (e) => e.checked)) !== on) {
    const saved = op.waitForResponse((r) => new URL(r.url()).pathname === "/api/tool-policies/create_ticket" && r.request().method() === "PUT");
    await op.click(sw);
    L.assert((await saved).status() === 200, `the Approvals UI saved the create_ticket policy (${on ? "approval required" : "approval off"})`);
  }
}
async function decideViaUi(op, kind, actionId) {
  await op.goto(L.BASE + "/approvals", { waitUntil: "networkidle0" });
  await openTab(op, "Waiting");
  const row = `[data-testid="approval-row"][data-action-id="${actionId}"]`;
  await op.waitForSelector(row + " button");
  await L.clickFirst(op, row + " button", kind === "approve" ? "Approve" : "Reject");
  const done = op.waitForResponse((r) => new URL(r.url()).pathname.endsWith(kind === "approve" ? "/approve" : "/reject") && r.request().method() === "POST");
  await L.clickLast(op, "button", kind === "approve" ? "Approve and run" : "Reject");
  return (await done).status();
}
(async () => {
  const out = {};
  const ob = await L.launch(creds.B.profile); const op = await ob.newPage(); await op.setExtraHTTPHeaders({ "X-Forwarded-For": "10.0.7.11" });
  await setApprovalPolicyViaUi(op, true);
  out.policy = sql(`select tool||' allowedForAI='||"allowedForAI"||' requiresHumanApproval='||"requiresHumanApproval" from "ToolPolicy" where tool='create_ticket' and "businessId"=${BIZB};`);
  const t0 = tickets();
  out.aiReply1 = await askTicket("Something is broken with my scooter battery. Please open a ticket.");
  const pend = sql(`select id||' | '||status||' | requestedBy='||"requestedBy" from "ActionExecution" where tool='create_ticket' and "businessId"=${BIZB} order by "createdAt" desc limit 1;`);
  out.pendingAction = pend; const id1 = pend.split(" | ")[0];
  out.ticketsWhilePending = `${t0} -> ${tickets()} (no side effect while pending)`;
  // owner (browser session) sees it in the API list
  await op.goto(L.BASE + "/tickets", { waitUntil: "networkidle0" });
  out.ownerSeesPending = (await call(op, "GET", "/api/actions?status=pending_approval")).j.data.map((a) => `${a.tool}:${a.status}`);
  // A fresh, action-scoped viewer/profile makes this denial path repeatable:
  // a retry must not inherit an old authenticated browser session or account.
  const viewerUsername = `viewer_b_${id1.slice(0, 8)}`;
  out.createViewer = (await L.createMember(op, { username: viewerUsername, password: "Viewer-Pass-2026!", name: "Vera Viewer", role: "viewer" })).status;
  const vb = await L.launch(`viewer-b-${id1}`); const vp = await vb.newPage(); await vp.setExtraHTTPHeaders({ "X-Forwarded-For": "10.0.7.31" });
  await vp.goto(L.BASE + "/login", { waitUntil: "networkidle0" }); await vp.type("input#username,input[name=username]", viewerUsername); await vp.type("input[type=password]", "Viewer-Pass-2026!"); await L.clickFirst(vp, "button", "Sign In"); await vp.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 10000 }).catch(() => {}); await L.sleep(800);
  out.viewerLoggedInAs = (await call(vp, "GET", "/api/auth")).j.user?.username;
  out.viewerApprove = (await call(vp, "POST", `/api/actions/${id1}/approve`, {})).s; out.viewerReject = (await call(vp, "POST", `/api/actions/${id1}/reject`, {})).s;
  out.stillPendingAfterViewer = sql(`select status from "ActionExecution" where id='${id1}';`); await vb.close();
  // owner approves through the real Approvals UI
  out.ownerApprove = await decideViaUi(op, "approve", id1);
  await L.sleep(500);
  // The real model supplies a valid but not fixture-specific title. Bind the
  // side effect to the approved action's durable result rather than matching
  // stand-in wording from its generated arguments.
  const approvedTicketId = sql(`select result->'data'->>'ticketId' from "ActionExecution" where id='${id1}';`);
  out.afterApprove = { status: sql(`select status from "ActionExecution" where id='${id1}';`), tickets: tickets(), ticketId: approvedTicketId, ticketLinked: sql(`select count(*) from "Ticket" where id='${approvedTicketId}' and "businessId"=${BIZB};`) };
  out.approveAgain = (await call(op, "POST", `/api/actions/${id1}/approve`, {})).s; out.ticketsAfterSecondApprove = tickets();
  // rejection path
  out.aiReply2 = await askTicket("Something is broken: the scooter brakes are failing. Open a ticket please.");
  const id2 = sql(`select id from "ActionExecution" where tool='create_ticket' and status='pending_approval' and "businessId"=${BIZB} order by "createdAt" desc limit 1;`);
  const t2 = tickets(); out.ownerReject = await decideViaUi(op, "reject", id2); await L.sleep(400);
  out.afterReject = { status: sql(`select status from "ActionExecution" where id='${id2}';`), tickets: `${t2} -> ${tickets()}` }; out.approveAfterReject = (await call(op, "POST", `/api/actions/${id2}/approve`, {})).s;
  out.activity = sql(`select action from "ActivityLog" where "businessId"=${BIZB} and (action like 'action.%' or action like 'tool.%') order by "createdAt";`).split("\n");
  await setApprovalPolicyViaUi(op, false);
  out.policyAfterReset = sql(`select "requiresHumanApproval" from "ToolPolicy" where tool='create_ticket' and "businessId"=${BIZB};`);

  L.assert(out.policy.includes("requiresHumanApproval=true"), `the approval policy is actually set, got ${out.policy}`);
  L.assert(["f", "false"].includes(out.policyAfterReset), `the policy was switched back off through the UI, got ${out.policyAfterReset}`);
  L.assert(out.pendingAction && out.pendingAction.includes("pending_approval"), `create_ticket lands pending_approval, got ${out.pendingAction}`);
  L.assert(out.ticketsWhilePending.match(/^(\d+) -> \1 /), `no ticket is created while the action is pending, got ${out.ticketsWhilePending}`);
  L.assert(out.ownerSeesPending.some((a) => a.startsWith("create_ticket:pending_approval")), `the owner sees the pending action, got ${JSON.stringify(out.ownerSeesPending)}`);
  L.assert(out.createViewer === 201, `the viewer account is created, got ${out.createViewer}`);
  L.assert(out.viewerLoggedInAs === viewerUsername, `the viewer logs in through the real UI, got ${out.viewerLoggedInAs}`);
  L.assert(out.viewerApprove === 403, `a viewer cannot approve, got ${out.viewerApprove}`);
  L.assert(out.viewerReject === 403, `a viewer cannot reject, got ${out.viewerReject}`);
  L.assert(out.stillPendingAfterViewer === "pending_approval", `the action is still pending after the viewer's denied attempts, got ${out.stillPendingAfterViewer}`);
  L.assert(out.ownerApprove === 200, `the owner's approval succeeds, got ${out.ownerApprove}`);
  L.assert(out.afterApprove.status === "succeeded", `the action succeeds after approval, got ${out.afterApprove.status}`);
  L.assert(Number(out.afterApprove.ticketLinked) === 1, `exactly one ticket is created by the approved action, got ${out.afterApprove.ticketLinked}`);
  L.assert(out.approveAgain === 409, `approving an already-approved action is rejected (409), got ${out.approveAgain}`);
  L.assert(out.ticketsAfterSecondApprove === out.afterApprove.tickets, `a second approve does not create a second ticket, got ${out.ticketsAfterSecondApprove} vs ${out.afterApprove.tickets}`);
  L.assert(out.ownerReject === 200, `the owner's rejection succeeds, got ${out.ownerReject}`);
  L.assert(out.afterReject.status === "cancelled", `a rejected action ends cancelled, got ${out.afterReject.status}`);
  L.assert(out.afterReject.tickets.match(/^(\d+) -> \1$/), `rejection creates no ticket, got ${out.afterReject.tickets}`);
  L.assert(out.approveAfterReject !== 200, `a cancelled action cannot later be approved, got ${out.approveAfterReject}`);

  L.finish("J13", out);
  await ob.close();
})().catch((e) => {
  console.error("ERR", e);
  // A failure midway must not leave approval switched on for the journeys that follow.
  try { sql(`update "ToolPolicy" set "requiresHumanApproval"=false where tool='create_ticket' and "businessId"=${BIZB};`); } catch (reset) { console.error("policy reset failed", reset.message); }
  process.exit(1);
});
