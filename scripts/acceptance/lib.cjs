// Shared browser harness: real headless Chromium (Playwright's cached build) driven via puppeteer-core.
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
// Everything the run produces (browser profiles, screenshots, snippets, evidence.jsonl) goes here; git-ignored.
const SP = process.env.ACC_WORK_DIR || path.join(__dirname, ".work");
fs.mkdirSync(SP, { recursive: true });
// Any Chromium/Chrome-for-Testing binary. Set CHROMIUM_PATH, or it falls back to the browser puppeteer installed.
// `puppeteer-core` alone has no browser of its own to resolve — `puppeteer.executablePath()` throws
// ("path argument must be of type string") on a plain `npm ci` with no prior CHROMIUM_PATH-driven
// install, which is exactly the state a future engineering agent starts from. The full `puppeteer`
// package is a devDependency here for this reason: it downloads and caches its own Chrome for
// Testing build, and puppeteer-core drives that binary identically. Falling back to it is what makes
// `start-all.sh`/`run.sh` work out of the box, with no manual CHROMIUM_PATH step.
function resolveChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    const p = puppeteer.executablePath();
    if (p) return p;
  } catch {
    // fall through
  }
  try {
    return require("puppeteer").executablePath();
  } catch (e) {
    throw new Error(
      "No Chromium/Chrome-for-Testing binary found. Run `npx puppeteer browsers install chrome` " +
        "or set CHROMIUM_PATH to an existing Chrome/Chromium binary. (" + e.message + ")"
    );
  }
}
const CHROMIUM = resolveChromium();
const BASE = process.env.ACC_BASE_URL || "http://localhost:3100";
exports.BASE = BASE; exports.SP = SP;
exports.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
exports.launch = async (name) => {
  const userDataDir = path.join(SP, "profiles", name);
  fs.mkdirSync(userDataDir, { recursive: true });
  return puppeteer.launch({ executablePath: CHROMIUM, headless: true, userDataDir, args: ["--no-sandbox", "--window-size=1280,900"], defaultViewport: { width: 1280, height: 900 } });
};
// Collects network + console evidence for a page.
exports.watch = (page, tag) => {
  const ev = { tag, requests: [], failed: [], consoleErrors: [], pageErrors: [] };
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/_next/") && r.status() < 400) return;
    ev.requests.push({ m: r.request().method(), s: r.status(), u: u.replace(BASE, ""), acao: r.headers()["access-control-allow-origin"] || null });
  });
  page.on("requestfailed", (r) => ev.failed.push({ u: r.url(), err: r.failure() && r.failure().errorText }));
  page.on("console", (m) => { if (m.type() === "error") ev.consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => ev.pageErrors.push(String(e).slice(0, 300)));
  return ev;
};
exports.shot = async (page, name) => { const f = path.join(SP, "shots", name + ".png"); fs.mkdirSync(path.dirname(f), { recursive: true }); await page.screenshot({ path: f }); return f; };
exports.text = async (page) => page.evaluate(() => document.body.innerText);
exports.log = (obj) => fs.appendFileSync(path.join(SP, "evidence.jsonl"), JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n");
// Click the LAST button/element whose trimmed text equals `text` (modals render on top of page content).
exports.clickLast = async (page, sel, text) => {
  const ok = await page.evaluate((sel, text) => { const els = [...document.querySelectorAll(sel)].filter((e) => e.innerText.trim() === text); if (!els.length) return false; els[els.length - 1].click(); return true; }, sel, text);
  if (!ok) throw new Error(`no '${sel}' with text '${text}'`);
};
exports.clickFirst = async (page, sel, text) => {
  const ok = await page.evaluate((sel, text) => { const el = [...document.querySelectorAll(sel)].find((e) => e.innerText.trim() === text); if (!el) return false; el.click(); return true; }, sel, text);
  if (!ok) throw new Error(`no '${sel}' with text '${text}'`);
};
exports.XFF = { A: "10.0.1.11", B: "10.0.1.12", agentA: "10.0.1.13", anon: "10.0.1.99" };
// Send a message through the embedded widget as a visitor and time each hop.
exports.widgetSend = async (page, text, { timeoutMs = 45000 } = {}) => {
  const before = await page.$$eval("#ziyrak-log > div", (d) => d.length);
  const beforeAssistant = await page.$$eval("#ziyrak-log > div", (ds) => ds.filter((d) => /color:\s*#0F172A|color: rgb\(15, 23, 42\)/.test(d.getAttribute("style") || "")).length);
  const t0 = Date.now();
  const respP = page.waitForResponse((r) => r.url().includes("/webchat/") && r.url().includes("/message") && !r.url().includes("/messages") && r.request().method() === "POST", { timeout: 15000 }).catch(() => null);
  await page.type("#ziyrak-input", text); await page.keyboard.press("Enter");
  const resp = await respP; const tAck = Date.now() - t0;
  const ack = resp ? { status: resp.status(), ms: tAck, acao: resp.headers()["access-control-allow-origin"] || null, body: await resp.text().catch(() => "") } : null;
  let reply = null;
  while (Date.now() - t0 < timeoutMs) {
    const lines = await page.$$eval("#ziyrak-log > div", (ds) => ds.map((d) => ({ style: d.getAttribute("style") || "", text: d.textContent })));
    const assistants = lines.filter((l) => /#0F172A|rgb\(15, 23, 42\)/.test(l.style) && !/text-align:\s*right/.test(l.style));
    if (assistants.length > beforeAssistant) { reply = assistants[assistants.length - 1].text; break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ack, replyMs: reply ? Date.now() - t0 : null, reply, log: await page.$$eval("#ziyrak-log > div", (ds) => ds.map((d) => d.textContent)) };
};

// Evidence queries against the acceptance database. Default: derived from ACC_DB (the same throwaway
// database start-all.sh was pointed at), never a hardcoded database name — a hardcoded default would
// silently read a stale `ziyrak_acceptance` left over from a previous run when this run used a
// differently-named fresh database, exactly the "hidden state from a previous session" this harness
// must not depend on. Override with ACC_PSQL for a non-docker/non-default-user Postgres, e.g.
// ACC_PSQL="psql postgresql://user:pw@host/dbname".
const { execSync } = require("child_process");
function defaultPsqlCommand() {
  if (process.env.ACC_PSQL) return process.env.ACC_PSQL;
  if (process.env.ACC_DB) {
    try {
      const u = new URL(process.env.ACC_DB);
      const db = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
      const user = decodeURIComponent(u.username || "postgres");
      return `docker exec -i owly-db-1 psql -U ${user} -d ${db} -At -F ' | '`;
    } catch {
      // malformed ACC_DB — fall through to the loud warning below
    }
  }
  console.error(
    "lib.cjs: neither ACC_PSQL nor ACC_DB is set — sql() is falling back to the hardcoded " +
      "'ziyrak_acceptance' database, which may be stale from a previous run. Set ACC_DB (as " +
      "start-all.sh requires) or ACC_PSQL explicitly."
  );
  return "docker exec -i owly-db-1 psql -U postgres -d ziyrak_acceptance -At -F ' | '";
}
exports.sql = (q) => execSync(defaultPsqlCommand(), { input: q, encoding: "utf8" }).trim();

// ---------------------------------------------------------------------------
// Pass/fail assertions. Every journey script must call exports.assert() for
// its acceptance-critical checks and finish with exports.finish() instead of
// a bare console.log — printing observed JSON and exiting 0 whenever nothing
// happened to throw is evidence collection, not acceptance verification: a
// journey must fail loudly (non-zero exit) the moment an expected 404 comes
// back 200, a secret leaks, or a count is wrong, not just when Puppeteer
// itself throws.
// ---------------------------------------------------------------------------
const failures = [];
exports.assert = (cond, msg) => {
  if (!cond) {
    failures.push(msg);
    console.error("ASSERT FAIL: " + msg);
  }
  return cond;
};
exports.finish = (journeyLabel, out) => {
  console.log(JSON.stringify(out, null, 1));
  exports.log({ journey: journeyLabel, ...out });
  if (failures.length) {
    console.error(`\n${journeyLabel}: ${failures.length} assertion(s) FAILED:`);
    for (const f of failures) console.error(" - " + f);
    process.exitCode = 1;
  } else {
    console.error(`\n${journeyLabel}: all assertions passed.`);
  }
};
