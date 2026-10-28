// L4.1c platform limits on the real UI: the super admin (B) changes a platform limit from the console with a reason; the change is
// audited with before/after; a new-workspace cap of 0 makes a signup fail with a clear message and create nothing; restoring the
// default (always, in finally) lets signups through again; a workspace owner (A) has no path to the limits.
const L = require("./lib.cjs"),
  creds = require("./creds.json");
const { randomUUID } = require("node:crypto");
const suffix = randomUUID().slice(0, 8);
const q = (v) => "'" + String(v).replaceAll("'", "''") + "'";
const call = (page, path, method, body, headers) =>
  page.evaluate(
    async (path, method, body, headers) => {
      const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json", ...headers } : undefined, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    path, method, body, headers || {}
  );
async function fill(page, id, value) {
  await page.$eval(id, (el) => { el.focus(); el.select(); });
  await page.keyboard.press("Backspace");
  if (value) await page.type(id, value);
}
async function setLimit(page, key, value, reason) {
  await page.select("#limitKey", key);
  await fill(page, "#limitValue", String(value));
  await fill(page, "#limitReason", reason);
  const pending = page.waitForResponse((r) => r.url().endsWith("/api/platform/ai-service") && r.request().method() === "POST");
  await page.click("#saveLimit");
  const res = await pending;
  L.assert(res.status() === 200, `saving ${key}=${value} returned 200 (${res.status()})`);
  await page.waitForNetworkIdle({ idleTime: 300 });
}
const signup = (page, tag) =>
  call(page, "/api/auth", "POST", { action: "signup", businessName: `J35 Co ${tag}`, username: `j35-${tag}`, email: `j35-${tag}@example.test`, password: "J35-password-ok-1", name: "J35" }, { "X-Forwarded-For": `198.51.100.${200 + Math.floor(Math.random() * 50)}` });

(async () => {
  const browsers = [];
  let admin;
  try {
    const sb = await L.launch(creds.B.profile);
    browsers.push(sb);
    admin = await sb.newPage();
    await admin.goto(L.BASE + "/platform/ai-service", { waitUntil: "networkidle0" });
    await admin.waitForSelector("#limitKey");
    const listed = await admin.$$eval('table[aria-label="Platform limits"] tbody tr', (r) => r.map((x) => x.innerText));
    L.assert(listed.length === 3, `three platform limits are listed (${listed.length})`);

    const before = L.sql(`SELECT count(*) FROM "Business"`);
    await setLimit(admin, "max_new_workspaces_per_day", 0, "J35 pause signups " + suffix);
    L.assert(L.sql(`SELECT value FROM "PlatformLimit" WHERE key='max_new_workspaces_per_day'`) === "0", "the cap is stored");
    const audit = L.sql(`SELECT details->>'before'||'>'||(details->>'after') FROM "PlatformAccessAudit" WHERE action='platform.limit.set' AND reason=${q("J35 pause signups " + suffix)}`);
    L.assert(/^\d+>0$/.test(audit), `the change is audited with before and after (${audit})`);

    const refused = await signup(admin, suffix + "a");
    L.assert(refused.status === 429 && /paused/i.test(JSON.stringify(refused.body)), `a signup over the cap is refused with a clear message (${refused.status})`);
    L.assert(L.sql(`SELECT count(*) FROM "Business"`) === before && L.sql(`SELECT count(*) FROM "User" WHERE username=${q("j35-" + suffix + "a")}`) === "0", "the refused signup created nothing");

    // Out-of-range and tampered values are refused by the server, not just the form.
    const bad = await call(admin, "/api/platform/ai-service", "POST", { action: "set_platform_limit", key: "max_new_workspaces_per_day", value: 999999999, reason: "J35" });
    L.assert(bad.status === 400, `a value above the largest allowed is refused (${bad.status})`);

    await setLimit(admin, "max_new_workspaces_per_day", 1000, "J35 restore " + suffix);
    const allowed = await signup(admin, suffix + "b");
    L.assert(allowed.status === 202, `signups work again after the restore (${allowed.status})`);

    const ob = await L.launch(creds.A.profile);
    browsers.push(ob);
    const owner = await ob.newPage();
    await owner.goto(L.BASE + "/", { waitUntil: "networkidle0" });
    const write = await call(owner, "/api/platform/ai-service", "POST", { action: "set_platform_limit", key: "max_new_workspaces_per_day", value: 1, reason: "x" });
    L.assert([401, 403].includes(write.status), `a workspace owner cannot change a platform limit (${write.status})`);
    L.assert(L.sql(`SELECT value FROM "PlatformLimit" WHERE key='max_new_workspaces_per_day'`) === "1000", "the refused owner write changed nothing");

    L.finish("J35-platform-limits", { limits: 3 });
  } finally {
    // Never leave signups paused for the journeys that follow or a rerun.
    L.sql(`DELETE FROM "PlatformLimit" WHERE key='max_new_workspaces_per_day'`);
    for (const b of browsers.reverse()) await b.close();
  }
})().catch((e) => {
  console.error("ERR", e.message);
  process.exitCode = 1;
});
