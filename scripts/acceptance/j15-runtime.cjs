const L = require("./lib.cjs"); const creds = require("./creds.json"); const { execSync } = require("child_process");
const sql = L.sql;
(async () => {
  const out = {};
  // 1. public assets, headers, redirects
  const hdr = async (path, extra = {}) => { const r = await fetch(L.BASE + path, { redirect: "manual", headers: extra }); return { status: r.status, location: r.headers.get("location"), type: r.headers.get("content-type"), cache: r.headers.get("cache-control"), acao: r.headers.get("access-control-allow-origin"), nosniff: r.headers.get("x-content-type-options"), xfo: r.headers.get("x-frame-options") }; };
  out.assets = { "/widget.js": await hdr("/widget.js?v=1"), "/widget.js (no version)": await hdr("/widget.js"), "/api/health": await hdr("/api/health"), "/api/openapi.json": await hdr("/api/openapi.json"), "/login": await hdr("/login"), "/ (unauthenticated)": await hdr("/"), "/_next static (favicon)": await hdr("/favicon.ico") };
  const js = await (await fetch(L.BASE + "/widget.js?v=1")).text();
  out.widgetJsChecks = { bytes: js.length, mentionsLocalhost3000: /localhost:3000/.test(js), hardcodedApiBase: /https?:\/\/[a-z0-9.-]+\/api/i.test(js), usesDataApiBase: js.includes("data-api-base") };
  out.snippetHost = require("fs").readFileSync(L.SP + "/snippet-A-rotated.html", "utf8").match(/src="([^"]+)"/)[1].replace(/\?.*/, "");
  // 2. every dashboard page under the production build, as Business A's owner
  const ob = await L.launch(creds.A.profile); const op = await ob.newPage(); await op.setExtraHTTPHeaders({ "X-Forwarded-For": "10.0.9.11" }); const ev = L.watch(op, "sweep");
  const pages = ["/", "/conversations", "/customers", "/tickets", "/knowledge", "/knowledge/test", "/canned-responses", "/automation", "/business-hours", "/team", "/sla", "/channels", "/webhooks", "/analytics", "/activity", "/admin", "/api-docs", "/settings"];
  out.pages = {};
  for (const path of pages) {
    const n0 = ev.requests.length, c0 = ev.consoleErrors.length, f0 = ev.failed.length, pe0 = ev.pageErrors.length;
    const resp = await op.goto(L.BASE + path, { waitUntil: "networkidle0" }).catch((e) => ({ status: () => "ERR " + e.message.slice(0, 30) })); await L.sleep(500);
    const bad = ev.requests.slice(n0).filter((r) => r.s >= 400).map((r) => `${r.s} ${r.m} ${r.u.split("?")[0]}`);
    out.pages[path] = { status: resp.status(), landed: op.url().replace(L.BASE, ""), badResponses: [...new Set(bad)], consoleErrors: [...new Set(ev.consoleErrors.slice(c0))].map((s) => s.slice(0, 100)), failedNonPrefetch: ev.failed.slice(f0).filter((f) => !f.u.includes("_rsc=")).length, pageErrors: ev.pageErrors.slice(pe0) };
    await L.sleep(1200); // stay well under the per-IP API budget, like a human
  }
  // Post-Phase-7 acceptance-run defect fixed: /settings was 501 for every
  // signed-up (non-Default) business (assertDefaultBusinessOnly on the
  // legacy singleton). Prove the fix live: edit the General tab through the
  // real UI, save it through /api/settings/business, and confirm it
  // persists across reload. `op` is already sitting on /settings, the last
  // page in the sweep above.
  out.settingsEdit = { before: await op.evaluate(async () => (await (await fetch("/api/settings/business")).json()).businessName) };
  const nameField = await op.$("input[placeholder='My Business']");
  out.settingsEdit.foundNameField = !!nameField;
  if (nameField) {
    await nameField.click({ clickCount: 3 });
    await nameField.type("Northwind Bakery (edited via /settings)");
    const saveResp = op.waitForResponse((r) => r.url().includes("/api/settings/business") && r.request().method() === "PUT", { timeout: 10000 }).catch(() => null);
    await L.clickFirst(op, "button", "Save");
    const sr = await saveResp;
    out.settingsEdit.saveStatus = sr ? sr.status() : null;
    await L.sleep(600);
    await L.shot(op, "j15-A-settings-edited");
    await op.reload({ waitUntil: "networkidle0" }); await L.sleep(500);
    out.settingsEdit.after = await op.evaluate(async () => (await (await fetch("/api/settings/business")).json()).businessName);
  }
  out.cookie = (await op.cookies()).map((k) => ({ name: k.name, httpOnly: k.httpOnly, secure: k.secure, sameSite: k.sameSite, path: k.path }));
  await ob.close();
  // 3. same visitor: new conversation, same Customer (design: visitorId outlives conversationId)
  const vb = await L.launch("visitor-reuse"); const vctx = await vb.createBrowserContext(); const vp = await vctx.newPage();
  await vp.goto("http://localhost:4020/", { waitUntil: "load" }); await vp.waitForSelector("#ziyrak-input"); await L.sleep(800);
  const first = await L.widgetSend(vp, "What is your verification code?");
  const ids1 = await vp.evaluate(() => ({ conv: Object.entries(localStorage).find(([k]) => k.startsWith("ziyrak_webchat_conversation_"))[1], visitor: Object.entries(localStorage).find(([k]) => k.startsWith("ziyrak_webchat_visitor_"))[1] }));
  await vp.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("ziyrak_webchat_conversation_")) localStorage.removeItem(k); });
  await vp.reload({ waitUntil: "load" }); await vp.waitForSelector("#ziyrak-input"); await L.sleep(800);
  out.newConversationWidgetLogEmpty = (await vp.$$eval("#ziyrak-log > div", (d) => d.length)) === 0;
  const second = await L.widgetSend(vp, "What is your verification code?");
  const ids2 = await vp.evaluate(() => ({ conv: Object.entries(localStorage).find(([k]) => k.startsWith("ziyrak_webchat_conversation_"))[1], visitor: Object.entries(localStorage).find(([k]) => k.startsWith("ziyrak_webchat_visitor_"))[1] }));
  await L.sleep(500);
  out.sameVisitor = { conversationChanged: ids1.conv !== ids2.conv, visitorIdSame: ids1.visitor === ids2.visitor, bothReplied: !!(first.reply && second.reply),
    customerIdsForBothConversations: sql(`select count(distinct "customerId") from "Conversation" where id in ('${ids1.conv}','${ids2.conv}');`), conversationsCreated: sql(`select count(*) from "Conversation" where id in ('${ids1.conv}','${ids2.conv}');`) };
  await vb.close();

  L.assert(out.assets["/widget.js"].status === 200, `/widget.js is public, got ${out.assets["/widget.js"].status}`);
  L.assert(out.assets["/widget.js"].type && out.assets["/widget.js"].type.includes("javascript"), `/widget.js is served as JavaScript, got ${out.assets["/widget.js"].type}`);
  L.assert(out.assets["/api/health"].status === 200, `/api/health is public, got ${out.assets["/api/health"].status}`);
  L.assert(!out.widgetJsChecks.mentionsLocalhost3000, `widget.js never mentions localhost:3000 (a dev-server leftover)`);
  L.assert(out.widgetJsChecks.bytes > 0, `widget.js is non-empty`);
  for (const [path, p] of Object.entries(out.pages)) {
    // 304 (Not Modified) is a normal, successful cached navigation, not a failure.
    L.assert(p.status === 200 || p.status === 304, `${path} loads as the authenticated owner, got ${p.status}`);
    L.assert(p.badResponses.length === 0, `${path}: no 4xx/5xx network responses, got ${JSON.stringify(p.badResponses)}`);
    L.assert(p.consoleErrors.length === 0, `${path}: no console errors, got ${JSON.stringify(p.consoleErrors)}`);
    L.assert(p.pageErrors.length === 0, `${path}: no page errors, got ${JSON.stringify(p.pageErrors)}`);
  }
  const authCookie = out.cookie.find((c) => c.name === "owly-token");
  L.assert(authCookie && authCookie.httpOnly === true && authCookie.secure === true && authCookie.sameSite === "Lax", `owly-token cookie attributes are correct, got ${JSON.stringify(authCookie)}`);
  L.assert(out.newConversationWidgetLogEmpty === true, `clearing the conversation key alone starts a fresh widget log`);
  L.assert(out.sameVisitor.conversationChanged === true, `a new conversation id is used after clearing the conversation key`);
  L.assert(out.sameVisitor.visitorIdSame === true, `the visitor id persists across conversations`);
  L.assert(out.sameVisitor.bothReplied === true, `both conversations got a reply`);
  L.assert(out.sameVisitor.customerIdsForBothConversations === "1", `the same visitor maps to exactly one Customer across both conversations, got ${out.sameVisitor.customerIdsForBothConversations}`);
  L.assert(out.sameVisitor.conversationsCreated === "2", `two distinct conversations were created, got ${out.sameVisitor.conversationsCreated}`);

  L.assert([200, 304].includes(out.pages["/settings"].status), `/settings loads for a signed-up business (not 501), got ${out.pages["/settings"].status}`);
  L.assert(out.settingsEdit.foundNameField === true, `the General tab's business-name field is on the page`);
  L.assert(out.settingsEdit.saveStatus === 200, `saving the business profile returns 200, got ${out.settingsEdit.saveStatus}`);
  L.assert(out.settingsEdit.after === "Northwind Bakery (edited via /settings)", `the edit persists across reload, got ${JSON.stringify(out.settingsEdit.after)}`);

  L.finish("J15", out);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
