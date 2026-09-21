const L = require("./lib.cjs");
const creds = require("./creds.json");
async function clickText(p, sel, text) {
  const els = await p.$$(sel);
  for (const e of els) { const t = await e.evaluate((n) => n.innerText.trim()); if (t.includes(text)) { await e.click(); return; } }
  throw new Error("no " + sel + " with text " + text);
}
(async () => {
  for (const key of ["A", "B"]) {
    const c = creds[key];
    const b = await L.launch(c.profile);
    const p = await b.newPage(); const ev = L.watch(p, "signup-" + key);
    await p.goto(L.BASE + "/setup", { waitUntil: "networkidle0" });
    await p.type("#name", c.name); await p.type("#username", c.user); await p.type("#password", c.pass); await p.type("#confirmPassword", c.pass);
    await clickText(p, "button", "Next");
    await p.waitForSelector("#businessName");
    await p.type("#businessName", c.biz); await p.type("#businessDesc", c.desc);
    await p.$eval("#welcomeMessage", (e) => (e.value = "")); await p.type("#welcomeMessage", c.welcome);
    await clickText(p, "button", c.tone);
    await L.shot(p, `j1-${key}-step2`);
    await clickText(p, "button", "Create Business");
    await p.waitForSelector("#aiProvider");
    await p.select("#aiProvider", "openai"); await p.select("#aiModel", "gpt-4o-mini");
    await p.type("#aiApiKey", "sk-standin-" + key.toLowerCase() + "-not-a-real-key");
    await clickText(p, "button", "Finish Setup");
    await p.waitForFunction(() => document.body.innerText.includes("Go to Dashboard"), { timeout: 15000 });
    await L.shot(p, `j1-${key}-done`);
    const wizardText = (await L.text(p)).slice(0, 500);
    await clickText(p, "button", "Go to Dashboard");
    await p.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }).catch(() => {});
    await L.sleep(1500);
    const cookies = (await p.cookies()).map((k) => ({ name: k.name, httpOnly: k.httpOnly, secure: k.secure, sameSite: k.sameSite, session: k.session, expiresIn: k.expires > 0 ? Math.round((k.expires - Date.now() / 1000) / 86400) + "d" : "session" }));
    await L.shot(p, `j1-${key}-dashboard`);
    const out = { key, urlAfter: p.url(), cookies, api: ev.requests.filter((r) => r.u.startsWith("/api/")).map((r) => `${r.m} ${r.s} ${r.u}`), failed: ev.failed, consoleErrors: ev.consoleErrors, pageErrors: ev.pageErrors, dashboardHead: (await L.text(p)).replace(/\n+/g, " | ").slice(0, 300), wizardText: wizardText.replace(/\n+/g, " | ") };
    console.log(JSON.stringify(out, null, 1)); L.log({ journey: 1, ...out });
    await b.close();
  }
})().catch((e) => { console.error("ERR", e); process.exit(1); });
