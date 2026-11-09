// After J20/J22: platform two-step sign-in through the real UI (setup code -> authenticator enrolment ->
// recovery codes -> challenge at login). Synthetic accounts only. Runs in `optional` mode; the forced
// `required` redirect is covered by the automated suites.
const L = require("./lib.cjs");
const creds = require("./creds.json");
const { randomUUID, createHmac } = require("node:crypto");
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const suffix = randomUUID().slice(0, 8);
const username = "mfa_operator_" + suffix;
const password = "Synthetic-mfa-" + randomUUID();
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function totp(secretText, atMs) {
  let bits = "";
  for (const ch of secretText.replace(/=+$/, "").toUpperCase()) bits += ALPHABET.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(atMs / 30000)));
  const mac = createHmac("sha1", key).update(msg).digest();
  const o = mac[19] & 15;
  const n = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(n % 1000000).padStart(6, "0");
}
async function signIn(page) {
  await page.goto(L.BASE + "/login", { waitUntil: "networkidle0" });
  await page.type("#username", username);
  await page.type("#password", password);
  await page.click('button[type="submit"]');
}
async function nextStep() {
  const step = Math.floor(Date.now() / 30000);
  while (Math.floor(Date.now() / 30000) === step) await L.sleep(1000);
}
(async () => {
  const browsers = [];
  try {
    const b = await L.launch(creds.B.profile);
    browsers.push(b);
    const page = await b.newPage();
    L.watch(page, "j37-super");
    await page.goto(L.BASE + "/platform/operators", { waitUntil: "networkidle0" });
    await page.waitForSelector("#operatorUsername");
    await page.type("#operatorUsername", username);
    await page.type("#operatorName", "Synthetic MFA operator");
    await page.type("#operatorPassword", password);
    await page.type("#provisionReason", "Synthetic MFA operator provisioning");
    const created = page.waitForResponse((r) => r.url().endsWith("/api/platform/operators") && r.request().method() === "POST");
    await page.click("#createOperator");
    const user = (await (await created).json()).result;
    L.assert(!!user.id, "operator created for MFA journey");
    await page.waitForSelector(`#mfaTarget option[value="${user.id}"]`);
    await page.select("#mfaTarget", user.id);
    await page.type("#mfaReason", "Synthetic MFA enrolment approval");
    await page.click("#issueMfaSetup");
    await page.waitForSelector("#mfaSetupCode");
    const setupCode = await page.$eval("#mfaSetupCode", (e) => e.innerText.trim());
    L.assert(setupCode.length >= 8, "super admin sees a one-time setup code");
    L.assert(
      L.sql('SELECT count(*) FROM "MfaSetupCode" WHERE "userId"=' + quote(user.id) + ' AND "usedAt" IS NULL') === "1",
      "setup code is stored hashed and unused"
    );

    const ob = await L.launch("j37-operator-" + suffix);
    browsers.push(ob);
    const op = await ob.newPage();
    L.watch(op, "j37-operator");
    await op.setExtraHTTPHeaders({ "X-Forwarded-For": "198.51.100.231" });
    await signIn(op);
    await op.waitForFunction(() => location.pathname !== "/login", { timeout: 20000 });
    await op.goto(L.BASE + "/platform/mfa", { waitUntil: "networkidle0" });
    await op.waitForSelector("#setupCode");
    await op.type("#setupCode", "WRONG-CODE-123");
    await op.click("#startEnrollment");
    await op.waitForSelector('[role="alert"]');
    L.assert(!(await op.$("#mfaSecret")), "a wrong setup code starts no enrolment");
    await op.$eval("#setupCode", (e) => { e.value = ""; });
    await op.type("#setupCode", setupCode);
    await op.click("#startEnrollment");
    await op.waitForSelector("#mfaSecret");
    const secret = await op.$eval("#mfaSecret", (e) => e.innerText.trim());
    L.assert(L.sql('SELECT count(*) FROM "User" WHERE "mfaEnabledAt" IS NULL AND id=' + quote(user.id)) === "1", "nothing is active before the first code");
    await op.type("#confirmCode", "000000");
    await op.click("#confirmEnrollment");
    await op.waitForSelector('[role="alert"]');
    L.assert(L.sql('SELECT count(*) FROM "User" WHERE "mfaEnabledAt" IS NULL AND id=' + quote(user.id)) === "1", "a wrong first code activates nothing");
    await op.$eval("#confirmCode", (e) => { e.value = ""; });
    await op.type("#confirmCode", totp(secret, Date.now()));
    await op.click("#confirmEnrollment");
    await op.waitForSelector("#recoveryCodes li");
    const recovery = await op.$$eval("#recoveryCodes li", (els) => els.map((e) => e.innerText.trim()));
    L.assert(recovery.length >= 8 && recovery.every((c) => /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/.test(c)), "recovery codes are shown once");
    L.assert(L.sql('SELECT count(*) FROM "User" WHERE "mfaEnabledAt" IS NOT NULL AND id=' + quote(user.id)) === "1", "enrolment is active after a valid code");
    L.assert(L.sql('SELECT count(*) FROM "MfaSetupCode" WHERE "userId"=' + quote(user.id) + ' AND "usedAt" IS NOT NULL') === "1", "setup code is single use");
    await L.shot(op, "j37-enrolled");

    // Fresh browser profile = signed out. Password alone must now stop at the challenge.
    await nextStep();
    const lb = await L.launch("j37-login-" + suffix);
    browsers.push(lb);
    const lp = await lb.newPage();
    L.watch(lp, "j37-login");
    await lp.setExtraHTTPHeaders({ "X-Forwarded-For": "198.51.100.232" });
    await signIn(lp);
    await lp.waitForSelector("#mfaCode");
    const noSession = await lp.evaluate(async () => (await (await fetch("/api/auth")).json()).authenticated);
    L.assert(!noSession, "password alone issues no session once a second factor exists");
    await lp.type("#mfaCode", "000000");
    await lp.click('button[type="submit"]');
    await lp.waitForFunction(() => document.body.innerText.includes("Invalid credentials"));
    L.assert(!(await lp.evaluate(async () => (await (await fetch("/api/auth")).json()).authenticated)), "a wrong code issues no session");
    await lp.$eval("#mfaCode", (e) => { e.value = ""; });
    await lp.$eval("#password", (e) => { e.value = ""; });
    await lp.type("#password", password);
    await lp.type("#mfaCode", totp(secret, Date.now()));
    await Promise.all([lp.waitForFunction(() => location.pathname !== "/login", { timeout: 20000 }), lp.click('button[type="submit"]')]);
    const entry = await lp.evaluate(async () => (await fetch("/api/platform/enrollment")).json());
    L.assert(entry.role === "operator" && entry.account.id === user.id, "a valid authenticator code signs in");

    // Recovery code path, in another signed-out profile; a code works exactly once.
    const rb = await L.launch("j37-recovery-" + suffix);
    browsers.push(rb);
    const rp = await rb.newPage();
    L.watch(rp, "j37-recovery");
    await rp.setExtraHTTPHeaders({ "X-Forwarded-For": "198.51.100.233" });
    for (const [n, expectOk] of [[0, true], [0, false]]) {
      await rp.goto(L.BASE + "/login", { waitUntil: "networkidle0" });
      await rp.type("#username", username);
      await rp.type("#password", password);
      await rp.click('button[type="submit"]');
      await rp.waitForSelector("#mfaCode");
      await rp.click("#toggleRecovery");
      await rp.type("#mfaCode", recovery[n]);
      await rp.click('button[type="submit"]');
      if (expectOk) {
        await rp.waitForFunction(() => location.pathname !== "/login", { timeout: 20000 });
        const ok = await rp.evaluate(async () => (await (await fetch("/api/auth")).json()).authenticated);
        L.assert(ok, "a recovery code signs in");
      } else {
        await rp.waitForFunction(() => document.body.innerText.includes("Invalid credentials"));
        L.assert(true, "a used recovery code is refused");
      }
      if (expectOk) {
        await rp.evaluate(async () => { await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "logout" }) }); });
      }
    }
    L.finish("J37-platform-mfa", {
      checks:
        "super admin issues a one-time setup code in the UI; operator rejects a wrong setup/first code, enrols an authenticator and sees recovery codes once; password alone, a wrong code and a used recovery code issue no session; a valid authenticator code and a recovery code sign in",
      limitations:
        "synthetic accounts; optional mode (the forced-enrolment redirect and required-mode enforcement are covered by automated suites)",
    });
  } finally {
    for (const x of browsers) await x.close().catch(() => {});
  }
})().catch((e) => { console.error(e); process.exit(1); });
