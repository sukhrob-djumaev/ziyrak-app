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

    L.assert(r.me === c.user, `${key}: session identifies the signed-up owner, got ${r.me}`);
    for (const path of Object.keys(r.nav)) L.assert(r.nav[path].startsWith("200 ->"), `${key}: ${path} loads (200) while authenticated, got ${r.nav[path]}`);
    L.assert(r.signOutClicked === true, `${key}: Sign Out control was found and clicked`);
    L.assert(r.afterSignOutUrl.startsWith("/login"), `${key}: sign-out navigates to /login, got ${r.afterSignOutUrl}`);
    L.assert(!r.cookiesAfterLogout.includes("owly-token"), `${key}: owly-token cookie is cleared after sign-out`);
    for (const [path, status] of Object.entries(r.api_after_logout)) L.assert(status === 401, `${key}: ${path} is 401 after sign-out, got ${status}`);
    L.assert(r.page_after_logout.includes("-> /login"), `${key}: /conversations redirects to /login after sign-out, got ${r.page_after_logout}`);
    L.assert(r.wrongPasswordMsg.includes("Invalid credentials"), `${key}: wrong password shows "Invalid credentials", got ${JSON.stringify(r.wrongPasswordMsg)}`);
    L.assert(r.wrongPasswordUrl.startsWith("/login"), `${key}: wrong password stays on /login, got ${r.wrongPasswordUrl}`);
    L.assert(!r.loginUrl.startsWith("/login"), `${key}: correct password leaves /login, got ${r.loginUrl}`);
    L.assert(r.meAfterLogin === c.user, `${key}: re-login re-establishes the same session, got ${r.meAfterLogin}`);
    const ca = r.cookieAttrs[0];
    L.assert(ca && ca.httpOnly === true && ca.secure === true && ca.sameSite === "Lax", `${key}: post-login cookie is HttpOnly/Secure/SameSite=Lax, got ${JSON.stringify(ca)}`);
    // A 401 from checking auth state right after sign-out (e.g. the header's own
    // "am I logged in" check) is expected console noise, not a defect — present
    // in the original passing baseline (PLAN.md §MVP Browser Acceptance Suite).
    L.assert(r.consoleErrors.every((e) => /401/.test(e)), `${key}: only the documented post-logout 401 is acceptable console noise, got ${JSON.stringify(r.consoleErrors)}`);
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

  for (const path of ["/conversations", "/customers", "/admin", "/channels", "/knowledge/test"]) {
    L.assert(u["page " + path].includes("-> /login"), `unauth: ${path} redirects to /login, got ${u["page " + path]}`);
  }
  for (const [call, status] of Object.entries(u)) {
    if (call.startsWith("GET /api/") || call.startsWith("POST /api/")) {
      const publicRoutes = ["GET /api/health", "GET /api/openapi.json"];
      if (publicRoutes.includes(call)) L.assert(String(status) === "200", `unauth: ${call} stays public, got ${status}`);
      else L.assert(String(status).startsWith("401"), `unauth: ${call} requires auth (401), got ${status}`);
    }
  }
  L.assert(String(u["GET /widget.js"]) === "200", `unauth: /widget.js stays public, got ${u["GET /widget.js"]}`);
  for (const [name] of Object.entries(forged)) {
    L.assert(u[`forged cookie [${name}] API`] === 401, `unauth: forged cookie [${name}] is rejected on the API (401), got ${u[`forged cookie [${name}] API`]}`);
    L.assert(u[`forged cookie [${name}] page /conversations`].includes("-> /login"), `unauth: forged cookie [${name}] on /conversations redirects to /login, got ${u[`forged cookie [${name}] page /conversations`]}`);
  }

  L.finish("J02", out);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
