// P1 enrollment/recovery through the real UI, synthetic owner proofs only.
const L = require("./lib.cjs");
const creds = require("./creds.json");
const bootstrap = process.env.ACC_PLATFORM_BOOTSTRAP_PROOF;
const recovery = process.env.ACC_PLATFORM_RECOVERY_PROOF;
if (!bootstrap || !recovery) throw Error("Synthetic platform acceptance proofs are required");
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
async function signedPage(key) {
  const browser = await L.launch(creds[key].profile),
    page = await browser.newPage();
  await page.goto(L.BASE + "/login", { waitUntil: "networkidle0" });
  if (!page.url().includes("/login")) {
    await page.evaluate(() =>
      fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      })
    );
    await page.goto(L.BASE + "/login", { waitUntil: "networkidle0" });
  }
  await page.type("#username", creds[key].user);
  await page.type("#password", creds[key].pass);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0" }),
    page.click('button[type="submit"]'),
  ]);
  await page.goto(L.BASE + "/platform/enrollment", { waitUntil: "networkidle0" });
  await page.waitForSelector("#ownerProof");
  return { browser, page, errors: L.watch(page, "j20-" + key) };
}
async function submit(page, proof, reason, status) {
  await page.click("#confirmAccount");
  await page.type("#ownerProof", proof);
  await page.type("#enrollmentReason", reason);
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/platform/enrollment") && r.request().method() === "POST"
  );
  await page.click('button[type="submit"]');
  L.assert(
    (await response).status() === status,
    "Enrollment response has expected status " + status
  );
  await page.waitForFunction(() => document.querySelector("#ownerProof")?.value === "");
}
(async () => {
  let a, b;
  try {
    a = await signedPage("A");
    await submit(a.page, "synthetic-wrong-proof", "Synthetic denied enrollment", 403);
    L.assert(await a.page.$('[role="alert"]'), "Wrong owner proof is visibly denied");
    L.assert(
      L.sql('SELECT count(*) FROM "User" WHERE "platformRole"=\'super_admin\'') === "0",
      "Denied proof creates no authority"
    );
    await a.page.$eval("#enrollmentReason", (el) => { el.focus(); el.select(); });
    await a.page.keyboard.press("Backspace");
    await submit(a.page, bootstrap, "Synthetic approved platform enrollment", 200);
    await a.page.waitForFunction(
      () =>
        document.body.innerText.includes("Super admin") &&
        document.body.innerText.includes("Authority generation: 1")
    );
    const first = await a.page.evaluate(async () =>
      (await fetch("/api/platform/enrollment")).json()
    );
    L.assert(
      first.role === "super_admin" && first.generation === 1 && !first.bootstrapAvailable,
      "Actual signed-in A holds generation one"
    );
    b = await signedPage("B");
    L.assert(
      (await b.page.evaluate(async () => (await fetch("/api/platform/enrollment")).json())).role ===
        null,
      "B does not inherit platform authority"
    );
    await b.page.select("#enrollmentAction", "recovery");
    await submit(b.page, recovery, "Synthetic explicit owner recovery", 200);
    await b.page.waitForFunction(
      () =>
        document.body.innerText.includes("Super admin") &&
        document.body.innerText.includes("Authority generation: 2")
    );
    const displaced = await a.page.evaluate(async () =>
      (await fetch("/api/platform/enrollment")).json()
    );
    L.assert(
      displaced.role === null && displaced.generation === 2,
      "Displaced A has no platform authority on the original session"
    );
    await a.page.reload({ waitUntil: "networkidle0" });
    L.assert(
      (await L.text(a.page)).includes("Platform role: None"),
      "UI refresh reflects displaced authority"
    );
    const audits = L.sql(
      "SELECT count(*) FROM \"PlatformAccessAudit\" WHERE action IN ('platform.bootstrap','platform.recovery')"
    );
    L.assert(
      audits === "2",
      "Both successful changes have mandatory persisted audit and denied proof has none"
    );
    const memberships = L.sql(
      `SELECT count(*) FROM "Membership" m JOIN "User" u ON u.id=m."userId" WHERE u.username IN (${quote(creds.A.user)},${quote(creds.B.user)}) AND m.role='owner'`
    );
    L.assert(memberships === "2", "Original workspace ownership remains legitimate");
    L.assert(
      a.errors.pageErrors.length + b.errors.pageErrors.length === 0,
      "No browser runtime errors"
    );
    await L.shot(b.page, "j20-recovered-platform-account");
    L.finish("J20-platform-enrollment", {
      topology: "Synthetic owner proofs, actual UI/session/Postgres; no support activation",
      firstGeneration: first.generation,
      recoveryGeneration: displaced.generation,
      displacedRole: displaced.role,
      audits,
      pageErrors: [...a.errors.pageErrors, ...b.errors.pageErrors],
    });
  } finally {
    if (b) await b.browser.close();
    if (a) await a.browser.close();
  }
})().catch((error) => {
  console.error("ERR", error.message);
  process.exitCode = 1;
});
