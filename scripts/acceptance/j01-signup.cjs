const L = require("./lib.cjs");
const creds = require("./creds.json");
// P3 signup journey: the real wizard (no AI step), the real verification email (captured to a file, nothing
// delivered), the real confirmation page and sign-in. Afterwards each workspace is put on its own AI key and
// activated as a CONTROLLED PREREQUISITE (SQL + the settings API), so the later journeys keep exercising the
// assistant with the stand-in provider; managed AI, onboarding and activation are covered by J27/J28.
// Real-model acceptance prep: with ACC_REAL_AI=1 (and start-all.sh started the same way, so no
// llm-standin/OPENAI_BASE_URL is in play) the workspace's own key is a REAL provider credential. The key is
// read once and never included in `out`/screenshots/logged evidence.
const REAL_AI = process.env.ACC_REAL_AI === "1";
const REAL_AI_PROVIDER = process.env.ACC_REAL_AI_PROVIDER || "openai";
const REAL_AI_MODEL = process.env.ACC_REAL_AI_MODEL || (REAL_AI_PROVIDER === "anthropic" ? "claude-sonnet-5-5" : "gpt-4o-mini");
const REAL_AI_KEY = process.env.ACC_REAL_AI_KEY;
if (REAL_AI && !REAL_AI_KEY) throw new Error("ACC_REAL_AI=1 but ACC_REAL_AI_KEY is not set");
async function clickText(p, sel, text) {
  const els = await p.$$(sel);
  for (const e of els) { const t = await e.evaluate((n) => n.innerText.trim()); if (t.includes(text)) { await e.click(); return; } }
  throw new Error("no " + sel + " with text " + text);
}
(async () => {
  for (const key of ["A", "B"]) {
    const c = creds[key];
    const email = `${c.user}@example.test`;
    const b = await L.launch(c.profile);
    const p = await b.newPage(); const ev = L.watch(p, "signup-" + key);
    const startedAt = Date.now() - 1000;
    // Each owner uses its own client address: the auth endpoints allow 5 attempts a minute per address.
    const ip = key === "A" ? "198.51.100.201" : "198.51.100.202";
    await p.setExtraHTTPHeaders({ "X-Forwarded-For": ip });
    await p.goto(L.BASE + "/setup", { waitUntil: "networkidle0" });
    await p.type("#name", c.name); await p.type("#username", c.user); await p.type("#email", email);
    await p.type("#password", c.pass); await p.type("#confirmPassword", c.pass);
    await clickText(p, "button", "Next");
    await p.waitForSelector("#businessName");
    await p.type("#businessName", c.biz); await p.type("#businessDesc", c.desc);
    await p.$eval("#welcomeMessage", (e) => (e.value = "")); await p.type("#welcomeMessage", c.welcome);
    await clickText(p, "button", c.tone);
    await L.shot(p, `j1-${key}-step2`);
    await clickText(p, "button", "Create Business");
    await p.waitForSelector("#checkEmail");
    await L.shot(p, `j1-${key}-check-email`);
    const wizardText = (await L.text(p)).slice(0, 500);
    L.assert(wizardText.includes(email), `${key}: the wizard tells the owner which address was mailed`);
    L.assert(!/\bAI\b|API key|provider/.test(wizardText), `${key}: signup shows no AI setup`);
    const cookiesAfterSignup = (await p.cookies()).filter((k) => k.name === "ziyrak-token");
    L.assert(cookiesAfterSignup.length === 0, `${key}: signup signs nobody in`);

    // The owner confirms the address from the emailed link (explicit button: a scanner's GET cannot consume it).
    const mail = await L.waitForMail(email, { after: startedAt, match: /verify-email/ });
    L.assert(!mail.text.includes(c.pass), `${key}: the mail never contains the password`);
    const vp = await b.newPage();
    await vp.setExtraHTTPHeaders({ "X-Forwarded-For": ip });
    await vp.goto(mail.link, { waitUntil: "networkidle0" });
    await vp.waitForSelector("#confirmEmail");
    await vp.click("#confirmEmail");
    await vp.waitForSelector("#verifyDone");
    const replay = await vp.evaluate(async (token) => (await fetch("/api/auth/verify-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })).status, mail.token);
    L.assert(replay === 400, `${key}: a used verification link cannot be replayed`);
    await vp.close();

    await p.goto(L.BASE + "/login", { waitUntil: "networkidle0" });
    await p.type("#username", c.user); await p.type("#password", c.pass);
    await Promise.all([p.waitForNavigation({ waitUntil: "networkidle0", timeout: 20000 }).catch(() => {}), p.click('button[type="submit"]')]);
    await L.sleep(1500);

    // Controlled prerequisite for the rest of the suite (see header).
    const biz = L.sql('SELECT m."businessId" FROM "Membership" m JOIN "User" u ON u.id=m."userId" WHERE u.username=\'' + c.user + "' AND m.role='owner'");
    L.assert(biz, `${key}: owner workspace exists`);
    L.assert(L.sql('SELECT "emailVerifiedAt" IS NOT NULL FROM "User" WHERE username=\'' + c.user + "'") === "true", `${key}: email is verified`);
    L.sql('UPDATE "WorkspaceAiAllowance" SET mode=\'legacy_byok\', status=\'active\' WHERE "businessId"=\'' + biz + "'");
    L.sql('UPDATE "OnboardingState" SET "activatedAt"=now() WHERE "businessId"=\'' + biz + "'");
    const apiKey = REAL_AI ? REAL_AI_KEY : "sk-standin-" + key.toLowerCase() + "-not-a-real-key";
    const saved = await p.evaluate(async (payload) => (await fetch("/api/settings/ai", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).status, { aiProvider: REAL_AI ? REAL_AI_PROVIDER : "openai", aiModel: REAL_AI ? REAL_AI_MODEL : "gpt-4o-mini", aiApiKey: apiKey });
    L.assert(saved === 200, `${key}: workspace AI configured on its own key (prerequisite)`);
    await p.goto(L.BASE + "/", { waitUntil: "networkidle0" });
    await L.sleep(1000);
    const cookies = (await p.cookies()).map((k) => ({ name: k.name, httpOnly: k.httpOnly, secure: k.secure, sameSite: k.sameSite, session: k.session, expiresIn: k.expires > 0 ? Math.round((k.expires - Date.now() / 1000) / 86400) + "d" : "session" }));
    await L.shot(p, `j1-${key}-dashboard`);
    const out = { key, urlAfter: p.url(), cookies, api: ev.requests.filter((r) => r.u.startsWith("/api/")).map((r) => `${r.m} ${r.s} ${r.u}`), failed: ev.failed, consoleErrors: ev.consoleErrors, pageErrors: ev.pageErrors, dashboardHead: (await L.text(p)).replace(/\n+/g, " | ").slice(0, 300), wizardText: wizardText.replace(/\n+/g, " | ") };

    L.assert(out.urlAfter.startsWith(L.BASE + "/") && !out.urlAfter.includes("/setup") && !out.urlAfter.includes("/login"), `${key}: landed on the dashboard after signing in, got ${out.urlAfter}`);
    const cookie = out.cookies.find((c) => c.name === "ziyrak-token");
    L.assert(!!cookie, `${key}: ziyrak-token cookie was set`);
    L.assert(cookie && cookie.httpOnly === true, `${key}: ziyrak-token is HttpOnly`);
    L.assert(cookie && cookie.secure === true, `${key}: ziyrak-token is Secure`);
    L.assert(cookie && cookie.sameSite === "Lax", `${key}: ziyrak-token is SameSite=Lax, got ${cookie && cookie.sameSite}`);
    L.assert(out.dashboardHead.includes(c.biz) || out.dashboardHead.includes("Dashboard"), `${key}: dashboard rendered`);
    L.assert(out.consoleErrors.length === 0, `${key}: no console errors on signup/dashboard, got ${JSON.stringify(out.consoleErrors)}`);
    L.assert(out.pageErrors.length === 0, `${key}: no page errors on signup/dashboard, got ${JSON.stringify(out.pageErrors)}`);
    const postAuth = out.api.find((a) => a.startsWith("POST 202 /api/auth"));
    L.assert(!!postAuth, `${key}: signup POST /api/auth returned 202, got ${JSON.stringify(out.api)}`);

    L.finish(`J01-${key}`, out);
    await b.close();
  }
})().catch((e) => { console.error("ERR", e); process.exit(1); });
