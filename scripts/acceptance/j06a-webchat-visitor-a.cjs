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
  console.log(JSON.stringify(out, null, 1)); L.log({ journey: 6, phase: "A-visitor1", ...out });
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
