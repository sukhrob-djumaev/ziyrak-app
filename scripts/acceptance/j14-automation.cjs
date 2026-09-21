const L = require("./lib.cjs"); const creds = require("./creds.json");
const RULE_REPLY = "AUTOMATION-RULE-REPLY: We are open 7am to 7pm every day. (This answer came from an automation rule, not the AI.)";
async function ask(site, text) { const b = await L.launch("visitor-j14"); const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.goto(site, { waitUntil: "load" }); await p.waitForSelector("#ziyrak-input"); await L.sleep(800); const r = await L.widgetSend(p, text); await b.close(); return r.reply; }
(async () => {
  const out = {};
  out.beforeRule = await ask("http://localhost:4020/", "What are your opening hours?");
  const ob = await L.launch(creds.A.profile); const op = await ob.newPage(); await op.setExtraHTTPHeaders({ "X-Forwarded-For": "10.0.8.11" }); const ev = L.watch(op, "auto");
  await op.goto(L.BASE + "/automation", { waitUntil: "networkidle0" });
  await op.evaluate(() => { const b = [...document.querySelectorAll("button")].find((b) => /rule/i.test(b.innerText) && /create|new|add/i.test(b.innerText)); b.click(); }); await L.sleep(600);
  await op.type("input[placeholder^='e.g. Route billing questions']", "Opening hours auto-answer");
  await L.clickLast(op, "button", "Auto Reply");
  await L.sleep(300);
  await op.type("input[placeholder='Value...']", "opening hours");
  await op.type("textarea[placeholder^='Auto-reply message content'],input[placeholder^='Auto-reply message content']", RULE_REPLY);
  await L.shot(op, "j14-A-rule-form");
  const saveResp = op.waitForResponse((r) => r.url().includes("/api/automation") && r.request().method() === "POST", { timeout: 10000 });
  await L.clickLast(op, "button", "Create Rule"); const sr = await saveResp; out.saveRule = sr.status(); await L.sleep(1200);
  await L.shot(op, "j14-A-rule-saved");
  out.ruleListed = (await L.text(op)).includes("Opening hours auto-answer");
  out.ruleApi = await op.evaluate(async () => (await (await fetch("/api/automation")).json()).data.map((r) => ({ name: r.name, type: r.type, isActive: r.isActive, requiresReconfirmation: r.requiresReconfirmation })));
  out.afterRule_A = await ask("http://localhost:4020/", "What are your opening hours?");
  out.afterRule_A_unrelated = await ask("http://localhost:4020/", "What is your verification code?");
  out.afterRule_B_sameQuestion = await ask("http://localhost:4021/", "What are your opening hours?");
  out.ruleFiredExactly = out.afterRule_A === RULE_REPLY; out.B_unaffected = out.afterRule_B_sameQuestion !== RULE_REPLY;
  out.console = [...new Set(ev.consoleErrors)];
  console.log(JSON.stringify(out, null, 1)); L.log({ journey: 14, ...out }); await ob.close();
})().catch((e) => { console.error("ERR", e); process.exit(1); });
