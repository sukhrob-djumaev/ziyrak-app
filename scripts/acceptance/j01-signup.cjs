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

    L.assert(out.urlAfter.startsWith(L.BASE + "/") && !out.urlAfter.includes("/setup") && !out.urlAfter.includes("/login"), `${key}: landed on the dashboard after signup, got ${out.urlAfter}`);
    const cookie = out.cookies.find((c) => c.name === "owly-token");
    L.assert(!!cookie, `${key}: owly-token cookie was set`);
    L.assert(cookie && cookie.httpOnly === true, `${key}: owly-token is HttpOnly`);
    L.assert(cookie && cookie.secure === true, `${key}: owly-token is Secure`);
    L.assert(cookie && cookie.sameSite === "Lax", `${key}: owly-token is SameSite=Lax, got ${cookie && cookie.sameSite}`);
    L.assert(out.wizardText.includes("Owner account created"), `${key}: wizard confirmed owner account created`);
    L.assert(out.wizardText.includes("Business profile configured"), `${key}: wizard confirmed business profile configured`);
    L.assert(out.wizardText.includes("AI provider configured"), `${key}: wizard confirmed AI provider configured`);
    L.assert(out.dashboardHead.includes(c.biz) || out.dashboardHead.includes("Dashboard"), `${key}: dashboard rendered`);
    L.assert(out.consoleErrors.length === 0, `${key}: no console errors on signup/dashboard, got ${JSON.stringify(out.consoleErrors)}`);
    L.assert(out.pageErrors.length === 0, `${key}: no page errors on signup/dashboard, got ${JSON.stringify(out.pageErrors)}`);
    const postAuth = out.api.find((a) => a.startsWith("POST 201 /api/auth"));
    L.assert(!!postAuth, `${key}: POST /api/auth returned 201, got ${JSON.stringify(out.api)}`);

    L.finish(`J01-${key}`, out);
    await b.close();
  }
})().catch((e) => { console.error("ERR", e); process.exit(1); });
