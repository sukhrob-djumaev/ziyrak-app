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
  console.log(JSON.stringify(out, null, 1)); L.log({ journey: 15, ...out });
})().catch((e) => { console.error("ERR", e); process.exit(1); });
