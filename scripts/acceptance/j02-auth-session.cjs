const L = require("./lib.cjs");
const creds = require("./creds.json");
const jwt = require("jsonwebtoken");
const XFF = { A: "10.0.0.11", B: "10.0.0.12", anon: "10.0.0.99", login: "10.0.0.13" };
const apiGet = (p, url) => p.evaluate(async (u) => { const r = await fetch(u); let b = null; try { b = await r.json(); } catch {} return { s: r.status, b }; }, url);
const clickText = async (p, sel, text) => { for (const e of await p.$$(sel)) { const t = await e.evaluate((n) => n.innerText.trim()); if (t === text) { await e.click(); return true; } } return false; };
(async () => {
  const out = { perBusiness: {}, unauth: {} };
  const tokens = {};
  for (const key of ["A", "B"]) {
    const c = creds[key];
    const b = await L.launch(c.profile);
    const p = await b.newPage(); await p.setExtraHTTPHeaders({ "X-Forwarded-For": XFF[key] }); const ev = L.watch(p, "j2-" + key);
    const r = {};
    await p.goto(L.BASE + "/", { waitUntil: "networkidle0" }); r.landing = p.url().replace(L.BASE, "");
    await p.reload({ waitUntil: "networkidle0" }); r.afterRefresh = p.url().replace(L.BASE, "");
    r.me = (await apiGet(p, "/api/auth")).b.user.username;
    r.nav = {};
    for (const path of ["/conversations", "/customers", "/tickets", "/knowledge", "/channels", "/team", "/activity"]) {
      const resp = await p.goto(L.BASE + path, { waitUntil: "networkidle0" }); r.nav[path] = `${resp.status()} -> ${p.url().replace(L.BASE, "") }`;
    }
    r.adminUsers = ((await apiGet(p, "/api/admin/users")).b.data || []).map((u) => u.username);
    tokens[key] = (await p.cookies()).find((k) => k.name === "owly-token").value;
    // real Sign Out through the avatar menu
    await p.goto(L.BASE + "/", { waitUntil: "networkidle0" });
    await clickText(p, "header button", "A"); await L.sleep(300);
    r.signOutClicked = await clickText(p, "button", "Sign Out");
    await p.waitForFunction(() => location.pathname.startsWith("/login"), { timeout: 10000 }).catch(() => {});
    r.afterSignOutUrl = p.url().replace(L.BASE, "");
    r.cookiesAfterLogout = (await p.cookies()).map((k) => k.name);
    r.api_after_logout = {};
    for (const u of ["/api/conversations", "/api/customers", "/api/admin/users"]) r.api_after_logout[u] = (await apiGet(p, u)).s;
    const resp = await p.goto(L.BASE + "/conversations", { waitUntil: "networkidle0" }); r.page_after_logout = `${resp.status()} -> ${p.url().replace(L.BASE, "")}`;
    // Log back in through the real login form: wrong password first, then right one
    await p.setExtraHTTPHeaders({ "X-Forwarded-For": XFF.login + key.charCodeAt(0) % 200 });
    await p.goto(L.BASE + "/login", { waitUntil: "networkidle0" });
    const inputs = await p.$$eval("input", (els) => els.map((e) => e.id || e.name || e.type));
    r.loginFormInputs = inputs;
    await p.type("input[type=text],input#username,input[name=username]", c.user); await p.type("input[type=password]", "wrong-password-123");
    await clickText(p, "button", "Sign In"); await L.sleep(1200);
    r.wrongPasswordMsg = (await L.text(p)).match(/Invalid credentials[^\n]*/)?.[0] || "(no message found)";
    r.wrongPasswordUrl = p.url().replace(L.BASE, "");
    await p.$eval("input[type=password]", (e) => (e.value = "")); await p.type("input[type=password]", c.pass);
    await clickText(p, "button", "Sign In"); await p.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 10000 }).catch(() => {});
    await L.sleep(800);
    r.loginUrl = p.url().replace(L.BASE, "");
    r.meAfterLogin = (await apiGet(p, "/api/auth")).b.user?.username;
    r.cookieAttrs = (await p.cookies()).filter((k) => k.name === "owly-token").map((k) => ({ httpOnly: k.httpOnly, secure: k.secure, sameSite: k.sameSite }));
    r.consoleErrors = [...new Set(ev.consoleErrors)]; r.failedNonPrefetch = ev.failed.filter((f) => !f.u.includes("_rsc="));
    out.perBusiness[key] = r; await b.close();
  }
  // Unauthenticated: fresh isolated context
  const b = await L.launch("anon"); const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.setExtraHTTPHeaders({ "X-Forwarded-For": XFF.anon });
  const u = out.unauth;
  for (const path of ["/", "/conversations", "/customers", "/admin", "/channels", "/knowledge/test"]) { const resp = await p.goto(L.BASE + path, { waitUntil: "networkidle0" }); u["page " + path] = `${resp.status()} -> ${p.url().replace(L.BASE, "")}`; }
  await p.goto(L.BASE + "/login");
  const calls = [["GET", "/api/conversations"], ["GET", "/api/customers"], ["GET", "/api/realtime?channel=global"], ["POST", "/api/chat", { message: "hi" }], ["GET", "/api/admin/users"], ["GET", "/api/channels/webchat-connections"], ["GET", "/api/actions"], ["POST", "/api/actions/x/approve", {}], ["GET", "/api/settings"], ["GET", "/api/health"], ["GET", "/api/openapi.json"], ["GET", "/widget.js"]];
  for (const [m, url, body] of calls) u[`${m} ${url}`] = await p.evaluate(async (m, url, body) => { const r = await fetch(url, { method: m, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, redirect: "manual" }); return r.status + (r.type === "opaqueredirect" ? " (redirect)" : ""); }, m, url, body);
  const forged = { "structurally-valid garbage a.b.c": "a.b.c", "JWT signed with wrong secret": jwt.sign({ userId: "x" }, "wrong-secret") };
  for (const [name, val] of Object.entries(forged)) {
    await ctx.setCookie({ name: "owly-token", value: val, domain: "localhost", path: "/" });
    u[`forged cookie [${name}] API`] = await p.evaluate(async () => (await fetch("/api/conversations")).status);
    u[`forged cookie [${name}] page /conversations`] = await p.goto(L.BASE + "/conversations").then((r) => `${r.status()} -> ${p.url().replace(L.BASE, "")}`);
  }
  await b.close();
  // Stateless-JWT observation: the pre-logout token of A, replayed from a plain HTTP client after A signed out
  const rep = await fetch(L.BASE + "/api/auth", { headers: { Cookie: "owly-token=" + tokens.A, "X-Forwarded-For": "10.0.0.98" } });
  out.replayOldTokenAfterLogout = { status: rep.status, user: (await rep.json()).user?.username };
  console.log(JSON.stringify(out, null, 1)); L.log({ journey: 2, ...out });
})().catch((e) => { console.error("ERR", e); process.exit(1); });
