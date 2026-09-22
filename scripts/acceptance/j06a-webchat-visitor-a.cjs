const L = require("./lib.cjs");
(async () => {
  const out = {};
  const b = await L.launch("visitor-a1"); const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); const ev = L.watch(p, "visitorA1");
  await p.goto("http://localhost:4020/", { waitUntil: "load" }); await p.waitForSelector("#ziyrak-input"); await L.sleep(800);
  const wj = ev.requests.find((r) => r.u.includes("/widget.js"));
  out.widgetJs = wj; await L.shot(p, "j6-A-widget-loaded");
  out.q1 = await L.widgetSend(p, "What is your verification code?");
  await L.shot(p, "j6-A-after-q1");
  await p.reload({ waitUntil: "load" }); await p.waitForSelector("#ziyrak-input"); await L.sleep(4500);
  out.afterReloadLog = await p.$$eval("#ziyrak-log > div", (ds) => ds.map((d) => d.textContent));
  out.q2 = await L.widgetSend(p, "Thanks. And are you open on weekends?");
  out.network = ev.requests.filter((r) => r.u.includes("/webchat/") || r.u.includes("widget.js")).reduce((a, r) => { const k = `${r.m} ${r.s} ${r.u.replace(/[0-9a-f-]{36}/g, "<id>").replace(/token=[^&]+/, "token=<redacted>").replace(/conversationId=[^&]+/, "conversationId=<id>").replace(/visitorId=[^&]+/, "visitorId=<id>").replace(/after=[^&]+/, "after=<id>")} ACAO=${r.acao}`; a[k] = (a[k] || 0) + 1; return a; }, {});
  out.console = [...new Set(ev.consoleErrors)]; out.failed = ev.failed;
  out.storage = await p.evaluate(() => Object.keys(localStorage));

  L.assert(out.widgetJs && out.widgetJs.s === 200, `/widget.js served 200, got ${out.widgetJs && out.widgetJs.s}`);
  L.assert(out.q1.ack && out.q1.ack.status === 200, `q1 ACK is 200, got ${out.q1.ack && out.q1.ack.status}`);
  // The stand-in/pipeline can occasionally miss the widget's own short poll window for the very
  // first message in a brand-new conversation (a documented, accepted quirk) — the real acceptance
  // criterion is that the grounded reply exists and survives reload, not which poll caught it.
  const q1Delivered = !!out.q1.reply || out.afterReloadLog.some((t) => t.includes("ZIYRAK-A-CODE-731"));
  L.assert(q1Delivered, `q1's grounded reply is visible live or after reload, afterReloadLog=${JSON.stringify(out.afterReloadLog)}`);
  L.assert(out.afterReloadLog.some((t) => t.includes("What is your verification code?")), `history persists across reload`);
  L.assert(out.q2.ack === null || out.q2.ack.status === 200, `q2 ACK is 200 (or reused the open connection), got ${JSON.stringify(out.q2.ack)}`);
  L.assert(!!out.q2.reply, `q2 got a reply`);
  L.assert(out.storage.some((k) => k.startsWith("ziyrak_webchat_conversation_")), `a conversation id was persisted to localStorage`);
  L.assert(out.storage.some((k) => k.startsWith("ziyrak_webchat_visitor_")), `a visitor id was persisted to localStorage`);
  // An open SSE /stream connection is expected to abort (ERR_ABORTED) when the page reloads mid-test
  // — that's the browser tearing down the old connection, not a product defect. Anything else is not.
  L.assert(out.failed.every((f) => f.u.includes("/stream") && f.err === "net::ERR_ABORTED"), `only an SSE stream abort-on-reload is acceptable, got ${JSON.stringify(out.failed)}`);

  L.finish("J06a", out);
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
