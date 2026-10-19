// P1 actual workspace entry/switch UI. Joining an existing identity is a
// controlled DB prerequisite until P3 invitations exist; it is not UI proof.
const L = require("./lib.cjs");
const creds = require("./creds.json");
const { randomUUID } = require("node:crypto");
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
async function choose(page, name) {
  const clicked = await page.evaluate((name) => {
    const button = [...document.querySelectorAll("button")].find((b) => b.innerText.includes(name));
    if (!button) return false;
    button.click();
    return true;
  }, name);
  if (!clicked) throw Error("Workspace choice missing: " + name);
  await page.waitForFunction(() => location.pathname === "/");
  await page.waitForFunction(
    (name) =>
      document.querySelector('header button[aria-label^="Account menu"]')?.title.includes(name),
    {},
    name
  );
}
(async () => {
  const out = {
    prerequisite:
      "Synthetic DB viewer membership in B for A's existing identity; P3 invitations remain unverified",
    roles: ["owner", "viewer"],
  };
  let browser;
  try {
    const a = L.sql(
      `SELECT u.id||'|'||m."businessId" FROM "User" u JOIN "Membership" m ON m."userId"=u.id WHERE u.username=${quote(creds.A.user)} AND m.role='owner'`
    ).split("|");
    const b = L.sql(
      `SELECT m."businessId" FROM "User" u JOIN "Membership" m ON m."userId"=u.id WHERE u.username=${quote(creds.B.user)} AND m.role='owner'`
    );
    if (!a[0] || !a[1] || !b) throw Error("Missing J01 synthetic owners");
    const membershipId = randomUUID();
    L.sql(
      `INSERT INTO "Membership"(id,"businessId","userId",role,"createdAt","scopeMode","customerProfileAccess") VALUES (${quote(membershipId)},${quote(b)},${quote(a[0])},'viewer',now(),'workspace','none')`
    );
    browser = await L.launch("p1-workspace-choice");
    const context = await browser.createBrowserContext(),
      page = await context.newPage(),
      watch = L.watch(page, "j18");
    await page.setExtraHTTPHeaders({ "X-Forwarded-For": "10.0.0.181" });
    await page.goto(L.BASE + "/login", { waitUntil: "load" });
    await page.waitForSelector("#username");
    await page.type("#username", creds.A.user);
    await page.type("#password", creds.A.pass);
    await L.clickFirst(page, "button", "Sign In");
    await page.waitForFunction(() => location.pathname === "/workspaces");
    await page.waitForFunction((name) => document.body.innerText.includes(name), {}, creds.B.biz);
    out.loginChoice = page.url().replace(L.BASE, "");
    out.picker = (await L.text(page)).replace(/\n+/g, " | ");
    L.assert(
      out.picker.includes(creds.A.biz) && out.picker.includes(creds.B.biz),
      "Actual picker shows both current memberships"
    );
    L.assert(
      !(await page.cookies()).some((c) => c.name === "ziyrak-workspace"),
      "Multi-workspace login cleared the old selection"
    );
    await choose(page, creds.B.biz);
    out.viewerWorkspace = await page.$eval(
      'header button[aria-label^="Account menu"]',
      (e) => e.title
    );
    L.assert(
      out.viewerWorkspace.includes(creds.B.biz),
      "Viewer selection renders B's workspace label"
    );
    const selection = (await page.cookies()).find((c) => c.name === "ziyrak-workspace");
    L.assert(
      selection?.value === b &&
        selection.httpOnly &&
        selection.secure &&
        selection.sameSite === "Lax",
      "Selected-workspace cookie is B and HttpOnly/Secure/SameSite Lax"
    );
    await page.goto(L.BASE + "/settings", { waitUntil: "load" });
    await page.waitForFunction(() => document.body.innerText.includes("Access denied"));
    out.viewerSettings = (await L.text(page)).includes("Access denied");
    L.assert(out.viewerSettings, "Viewer's actual Settings UI denies administrator data");
    // API attack assertion supplements the real UI; no UI offers a guessed-ID action.
    out.guessedWorkspaceStatus = await page.evaluate(
      async (id) =>
        (
          await fetch("/api/workspaces", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspaceId: id }),
          })
        ).status,
      randomUUID()
    );
    L.assert(out.guessedWorkspaceStatus === 403, "Guessed workspace ID is denied");
    L.assert(
      (await page.cookies()).find((c) => c.name === "ziyrak-workspace")?.value === b,
      "Failed guess does not change selection"
    );
    // Remove only the exact synthetic fixture membership, leaving both owners intact.
    L.sql(
      `DELETE FROM "Membership" WHERE id=${quote(membershipId)} AND "businessId"=${quote(b)} AND "userId"=${quote(a[0])} AND role='viewer'`
    );
    await page.goto(L.BASE + "/", { waitUntil: "load" });
    await page.waitForFunction(() => location.pathname === "/workspaces");
    await page.waitForFunction((name) => document.body.innerText.includes(name), {}, creds.A.biz);
    out.revokedChoice = (await L.text(page)).replace(/\n+/g, " | ");
    L.assert(
      !out.revokedChoice.includes(creds.B.biz),
      "Revoked selected membership returns to picker without B"
    );
    await choose(page, creds.A.biz);
    out.ownerWorkspace = await page.$eval(
      'header button[aria-label^="Account menu"]',
      (e) => e.title
    );
    L.assert(out.ownerWorkspace.includes(creds.A.biz), "Owner selection reloads A's own workspace");
    await page.goto(L.BASE + "/settings", { waitUntil: "load" });
    await page.waitForSelector("input[placeholder='My Business']");
    out.ownerSettings = await page.$eval("input[placeholder='My Business']", (e) => e.value);
    L.assert(
      out.ownerSettings.startsWith(creds.A.biz),
      "Owner's actual Settings form contains A's saved business name"
    );
    await L.shot(page, "j18-owner-workspace");
    out.pageErrors = watch.pageErrors;
    L.assert(out.pageErrors.length === 0, "No workspace-choice client runtime errors");
    L.finish("J18-P1-workspace-choice", out);
  } finally {
    if (browser) await browser.close();
  }
})().catch((error) => {
  console.error("ERR", error);
  process.exitCode = 1;
});
