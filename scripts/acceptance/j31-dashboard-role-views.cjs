// L3.1 dashboard/access coherence across all five workspace roles on the real UI:
// navigation matches the server permission, direct URLs show an explicit denial without mounting protected requests,
// write controls are absent for read-only roles, failed writes keep the form open with a reason, My account is separate
// from Workspace settings. Roles are provisioned through the real invitation UI as in J21.
const L = require("./lib.cjs");
const creds = require("./creds.json");
const { randomUUID } = require("node:crypto");
const suffix = randomUUID().slice(0, 8);
const ORDER = ["viewer", "agent", "supervisor", "admin", "owner"];
const rank = (r) => ORDER.indexOf(r);
// Independent of the app's own table: the minimum role per page, from the written RBAC contract.
const PAGES = [
  ["/conversations", "viewer"], ["/customers", "viewer"], ["/tickets", "viewer"], ["/knowledge", "viewer"],
  ["/automation", "viewer"], ["/business-hours", "viewer"], ["/team", "viewer"], ["/sla", "viewer"], ["/analytics", "viewer"],
  ["/canned-responses", "agent"],
  ["/approvals", "supervisor"], ["/channels", "supervisor"], ["/webhooks", "supervisor"], ["/activity", "supervisor"],
  ["/admin", "admin"], ["/settings", "admin"],
];
const allowed = (role, min) => rank(role) >= rank(min);
const roles = ["admin", "supervisor", "agent", "viewer"];

(async () => {
  const browsers = [];
  try {
    const ownerBrowser = await L.launch(creds.A.profile);
    browsers.push(ownerBrowser);
    const owner = await ownerBrowser.newPage();
    await owner.setExtraHTTPHeaders({ "X-Forwarded-For": "198.51.100.241" });
    await owner.goto(L.BASE + "/admin", { waitUntil: "networkidle0" });
    L.assert(!owner.url().includes("/login"), "Owner session is available");

    const accounts = [];
    for (const role of roles) {
      const account = { role, username: `j31_${role}_${suffix}`, password: randomUUID() + "!", name: `Views ${role} ${suffix}` };
      const email = `${account.username}@example.test`.toLowerCase();
      const startedAt = Date.now() - 1000;
      await L.clickFirst(owner, "button", "Invite User");
      await owner.waitForSelector("#inviteEmail");
      await owner.type("#inviteEmail", email);
      await owner.select(".fixed select", role);
      const sent = owner.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/users" && r.request().method() === "POST");
      await L.clickLast(owner, "button", "Send Invitation");
      L.assert((await sent).status() === 201, `${role}: invitation sent through the real UI`);
      await owner.waitForFunction(() => !document.querySelector("#inviteEmail"));
      const mail = await L.waitForMail(email, { after: startedAt, match: /accept-invitation/ });
      const accepted = await fetch(L.BASE + "/api/auth/invitation/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${150 + accounts.length}` },
        body: JSON.stringify({ token: mail.token, username: account.username, password: account.password, name: account.name }),
      });
      L.assert(accepted.ok, `${role}: invited person created their account`);
      accounts.push(account);
    }

    async function check(page, role) {
      // 1. Navigation equals the contract.
      await page.goto(L.BASE + "/", { waitUntil: "networkidle0" });
      const links = await page.$$eval("nav a", (a) => a.map((x) => new URL(x.href).pathname));
      for (const [path, min] of PAGES)
        L.assert(links.includes(path) === allowed(role, min), `${role}: navigation ${allowed(role, min) ? "shows" : "hides"} ${path}`);
      L.assert(links.includes("/workspaces"), `${role}: can always switch workspace`);

      // 2. Direct URLs: explicit denial and no protected request, or the real page.
      for (const [path, min] of PAGES) {
        const apiCalls = [];
        const watch = (r) => {
          const p = new URL(r.url()).pathname;
          if (p.startsWith("/api/") && !/^\/api\/(me|actions|realtime|auth)/.test(p)) apiCalls.push(p);
        };
        page.on("request", watch);
        await page.goto(L.BASE + path, { waitUntil: "networkidle0" });
        page.off("request", watch);
        const denied = await page.$('[data-testid="access-denied"]');
        const text = await page.evaluate(() => document.body.innerText);
        if (allowed(role, min)) L.assert(!denied && !text.includes("Access denied"), `${role}: ${path} opens`);
        else {
          L.assert(!!denied, `${role}: ${path} shows an explicit denial`);
          L.assert(apiCalls.length === 0, `${role}: denied ${path} issued no data requests (${apiCalls.join(",")})`);
        }
      }

      // 3. Write controls follow the permission (Team page: admin writes only).
      await page.goto(L.BASE + "/team", { waitUntil: "networkidle0" });
      const addButton = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => /^Add (Department|Member)$/.test(b.textContent.trim())));
      L.assert(addButton === allowed(role, "admin"), `${role}: Team add control ${addButton ? "shown" : "absent"} matches permission`);
      await page.goto(L.BASE + "/webhooks", { waitUntil: "networkidle0" });
      if (allowed(role, "supervisor")) {
        const addHook = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => /Add (Your First )?Webhook/.test(b.textContent)));
        L.assert(addHook === allowed(role, "admin"), `${role}: Webhook add control matches permission`);
      }
      if (allowed(role, "supervisor") && !allowed(role, "admin")) {
        await page.goto(L.BASE + "/channels", { waitUntil: "networkidle0" });
        L.assert(await page.evaluate(() => !!document.querySelector("fieldset[disabled]")), `${role}: Channels are read-only`);
        L.assert((await page.evaluate(() => document.body.innerText)).includes("can see channel status but not change it"), `${role}: read-only reason is stated`);
      }

      // 4. Personal account is separate from workspace settings.
      await page.goto(L.BASE + "/", { waitUntil: "networkidle0" });
      await page.click('header button[aria-label^="Account menu"]');
      const menu = await page.evaluate(() => document.body.innerText);
      L.assert(menu.includes("My account") && menu.includes("Switch workspace"), `${role}: account menu has My account and Switch workspace`);
      L.assert(menu.includes("Workspace settings") === allowed(role, "admin"), `${role}: Workspace settings entry only with settings permission`);
      L.assert(!(await page.$('header button[title="Search"]')), `${role}: no inert search control`);
      await page.goto(L.BASE + "/account", { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="account-details"]');
      const details = await page.$eval('[data-testid="account-details"]', (e) => e.innerText.toLowerCase());
      L.assert(details.includes(role), `${role}: My account shows the role`);
      await L.shot(page, "j31-" + role);
    }

    await check(owner, "owner");

    // 5. Failed writes keep the form open with the entered values and a reason (admin path, forced server rejection).
    const adminAcc = accounts.find((a) => a.role === "admin");
    const adminBrowser = await L.launch(`j31-admin-${suffix}`);
    browsers.push(adminBrowser);
    const admin = await adminBrowser.newPage();
    await admin.setExtraHTTPHeaders({ "X-Forwarded-For": "198.51.100.246" });
    await admin.goto(L.BASE + "/login", { waitUntil: "networkidle0" });
    await admin.type("#username", adminAcc.username);
    await admin.type("#password", adminAcc.password);
    await Promise.all([admin.waitForNavigation({ waitUntil: "networkidle0" }), admin.click('button[type="submit"]')]);
    await admin.waitForSelector('header button[aria-label^="Account menu"]');
    await check(admin, "admin");
    await admin.goto(L.BASE + "/webhooks", { waitUntil: "networkidle0" });
    await admin.setRequestInterception(true);
    let mode = "reject";
    admin.on("request", (r) => {
      if (mode === "reject" && r.method() === "POST" && new URL(r.url()).pathname === "/api/webhooks")
        r.respond({ status: 500, contentType: "application/json", body: JSON.stringify({}) });
      else r.continue();
    });
    await L.clickFirst(admin, "button", "Add Webhook");
    await admin.waitForSelector('input[placeholder="Slack Notification"]');
    await admin.type('input[placeholder="Slack Notification"]', "Rejected hook");
    await admin.type('input[type="url"], input[placeholder^="https"]', "https://example.test/hook");
    await L.clickLast(admin, "button", "Create Webhook");
    await admin.waitForSelector('[role="alert"]');
    const alertText = await admin.$eval('[role="alert"]', (e) => e.innerText);
    L.assert(/could not save/i.test(alertText), "Rejected webhook write shows a reason");
    L.assert((await admin.$eval('input[placeholder="Slack Notification"]', (e) => e.value)) === "Rejected hook", "Rejected webhook write keeps the entered values");
    mode = "off";
    await admin.setRequestInterception(false);

    L.finish("J31-dashboard-role-views", { roles: ["owner", ...roles], pages: PAGES.length });
  } finally {
    for (const b of browsers.reverse()) await b.close();
  }
})().catch((error) => {
  console.error("ERR", error.message);
  process.exitCode = 1;
});
