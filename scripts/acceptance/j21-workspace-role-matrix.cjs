// Supplementary P1 human-role UI/API matrix on the frozen full-suite candidate.
// Accounts are created through the real secured workspace UI, not invitations.
const L = require("./lib.cjs");
const creds = require("./creds.json");
const { randomUUID } = require("node:crypto");
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const suffix = randomUUID().slice(0, 8);
const roles = ["admin", "supervisor", "agent", "viewer"];
async function api(page, path) {
  return page.evaluate(async (path) => (await fetch(path)).status, path);
}
(async () => {
  const browsers = [],
    results = [];
  try {
    const ownerBrowser = await L.launch(creds.A.profile);
    browsers.push(ownerBrowser);
    const owner = await ownerBrowser.newPage();
    await owner.setExtraHTTPHeaders({ "X-Forwarded-For": "198.51.100.221" });
    await owner.goto(L.BASE + "/admin", { waitUntil: "networkidle0" });
    L.assert(!owner.url().includes("/login"), "Full-suite owner session is available");
    const anonymousContext = await ownerBrowser.createBrowserContext();
    const anonymous = await anonymousContext.newPage();
    await anonymous.goto(L.BASE + "/platform/enrollment", { waitUntil: "load" });
    await anonymous.waitForSelector("#username");
    L.assert(
      new URL(anonymous.url()).pathname === "/login",
      "Anonymous enrollment page redirects to real sign-in"
    );
    L.assert(
      (await api(anonymous, "/api/platform/enrollment")) === 401,
      "Anonymous enrollment API denies"
    );
    await anonymousContext.close();
    L.assert(
      (await api(owner, "/api/platform/enrollment")) === 200,
      "Cookie-only enrollment control succeeds before API-key denial"
    );
    const keyDenied = await owner.evaluate(
      async () =>
        (
          await fetch("/api/platform/enrollment", {
            headers: { "x-api-key": "synthetic-no-human-authority" },
          })
        ).status
    );
    L.assert(
      keyDenied === 403,
      "API-key header cannot borrow a signed-in person's enrollment authority"
    );
    const ownerMembership = L.sql(
      `SELECT m.id FROM "Membership" m JOIN "User" u ON u.id=m."userId" WHERE u.username=${quote(creds.A.user)} AND m.role='owner'`
    );
    L.assert(!!ownerMembership, "Legitimate protected owner membership exists");
    const foreignId = L.sql(
      `SELECT c.id FROM "Conversation" c JOIN "Membership" m ON m."businessId"=c."businessId" JOIN "User" u ON u.id=m."userId" WHERE u.username=${quote(creds.B.user)} AND m.role='owner' AND c."retiredAt" IS NULL ORDER BY c."createdAt" DESC LIMIT 1`
    );
    L.assert(!!foreignId, "A persisted foreign-workspace conversation exists");
    const ownId = L.sql(
      `SELECT c.id FROM "Conversation" c JOIN "Membership" m ON m."businessId"=c."businessId" JOIN "User" u ON u.id=m."userId" WHERE u.username=${quote(creds.A.user)} AND m.role='owner' AND c."retiredAt" IS NULL ORDER BY c."createdAt" DESC LIMIT 1`
    );
    L.assert(!!ownId, "A persisted A conversation exists for the platform boundary");
    const superBrowser = await L.launch(creds.B.profile);
    browsers.push(superBrowser);
    const superPage = await superBrowser.newPage();
    await superPage.goto(L.BASE + "/platform/enrollment", { waitUntil: "networkidle0" });
    const platformRole = await superPage.evaluate(
      async () => (await (await fetch("/api/platform/enrollment")).json()).role
    );
    L.assert(platformRole === "super_admin", "Actual J20 recovered super admin session is used");
    const platformForeignStatus = await api(superPage, "/api/conversations/" + ownId);
    L.assert(
      platformForeignStatus === 404,
      "Super admin has no implicit tenant data access outside legitimate B membership"
    );
    await superBrowser.close();
    browsers.pop();
    const accounts = [];
    for (const role of roles) {
      const account = {
        role,
        username: `j21_${role}_${suffix}`,
        password: randomUUID() + "!",
        name: `Role matrix ${role} ${suffix}`,
      };
      // P3: the real UI invites an email address; the new person then accepts with their own credentials.
      const email = `${account.username}@example.test`.toLowerCase();
      const startedAt = Date.now() - 1000;
      await L.clickFirst(owner, "button", "Invite User");
      await owner.waitForSelector("#inviteEmail");
      await owner.type("#inviteEmail", email);
      await owner.select(".fixed select", role);
      const creating = owner.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/admin/users" && r.request().method() === "POST"
      );
      await L.clickLast(owner, "button", "Send Invitation");
      L.assert((await creating).status() === 201, `${role}: actual secured UI sent an invitation`);
      await owner.waitForFunction(() => !document.querySelector("#inviteEmail"));
      const mail = await L.waitForMail(email, { after: startedAt, match: /accept-invitation/ });
      const accepted = await fetch(L.BASE + "/api/auth/invitation/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${10 + accounts.length}` },
        body: JSON.stringify({ token: mail.token, username: account.username, password: account.password, name: account.name }),
      });
      L.assert(accepted.ok, `${role}: the invited person created their own account`);
      const saved = L.sql(
        `SELECT m.role||'|'||m."scopeMode"||'|'||coalesce(u."platformRole"::text,'none') FROM "User" u JOIN "Membership" m ON m."userId"=u.id WHERE u.username=${quote(account.username)}`
      );
      L.assert(
        saved === `${role}|workspace|none`,
        `${role}: persisted explicit workspace role without platform privilege`
      );
      accounts.push(account);
    }
    async function inspect(page, role) {
      const permittedAdmin = role === "owner" || role === "admin";
      const permittedActions = permittedAdmin || role === "supervisor";
      const ownRead = await page.evaluate(async (id) => {
        const response = await fetch("/api/conversations/" + id);
        const body = await response.json();
        return { status: response.status, id: body.id };
      }, ownId);
      L.assert(
        ownRead.status === 200 && ownRead.id === ownId,
        `${role}: authorized real conversation row is returned`
      );
      const statuses = {
        conversations: await api(page, "/api/conversations"),
        ownConversation: ownRead.status,
        users: await api(page, "/api/admin/users"),
        settings: await api(page, "/api/settings/business"),
        approvals: await api(page, "/api/actions"),
        foreignConversation: await api(page, "/api/conversations/" + foreignId),
        ownerDemotion: await page.evaluate(
          async (id) =>
            (
              await fetch("/api/admin/users/" + id, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ role: "admin" }),
              })
            ).status,
          ownerMembership
        ),
      };
      L.assert(statuses.conversations === 200, `${role}: ordinary conversation read allowed`);
      L.assert(
        statuses.users === (permittedAdmin ? 200 : 403),
        `${role}: user administration permission enforced`
      );
      L.assert(
        statuses.settings === (permittedAdmin ? 200 : 403),
        `${role}: settings permission enforced`
      );
      L.assert(
        statuses.approvals === (permittedActions ? 200 : 403),
        `${role}: approval read permission enforced`
      );
      L.assert(
        statuses.foreignConversation === 404,
        `${role}: known foreign conversation remains hidden`
      );
      const protectedRequests = [];
      const watchAdmin = (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/admin/"))
          protectedRequests.push(request.url());
      };
      page.on("request", watchAdmin);
      await page.goto(L.BASE + "/admin", { waitUntil: "networkidle0" });
      page.off("request", watchAdmin);
      L.assert(
        statuses.ownerDemotion === 403,
        `${role}: generic team management cannot demote the owner`
      );
      const rows = await page.$$eval("table tbody tr", (rows) =>
        rows.map((row) => row.textContent || "")
      );
      L.assert(
        permittedAdmin ? rows.some((row) => row.includes(creds.A.user)) : rows.length === 0,
        `${role}: actual Administration table exposes protected rows only with permission`
      );
      const presentation = await page.evaluate(() => ({
        denied: document.body.innerText.includes("Access denied"),
        controls: [...document.querySelectorAll("button")].some((button) =>
          ["Invite User", "API Keys", "Generate New Key"].includes(button.textContent.trim())
        ),
        navigation: !!document.querySelector('nav a[href="/admin"]'),
      }));
      L.assert(
        permittedAdmin
          ? presentation.controls && presentation.navigation && !presentation.denied
          : presentation.denied && !presentation.controls && !presentation.navigation,
        `${role}: actual page controls/navigation match server permission`
      );
      if (!permittedAdmin)
        L.assert(
          protectedRequests.length === 0,
          `${role}: denied page never mounts protected list requests`
        );
      if (permittedAdmin)
        L.assert(
          await page.$$eval(
            "table tbody tr",
            (rows, username) => {
              const row = rows.find((row) => row.textContent.includes(username));
              return !!row && row.querySelectorAll("button").length === 0;
            },
            creds.A.user
          ),
          `${role}: owner row exposes no generic mutation control`
        );
      // This is explicit denial UI, not an HTTP403 document claim.
      results.push({
        role,
        statuses,
        administrationPage: permittedAdmin
          ? "authorized rows visible"
          : "explicit denial without protected client, rows, controls or navigation",
      });
      await L.shot(page, "j21-" + role);
      const settingsRequests = [];
      const watchSettings = (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/settings"))
          settingsRequests.push(request.url());
      };
      page.on("request", watchSettings);
      await page.goto(L.BASE + "/settings", { waitUntil: "networkidle0" });
      page.off("request", watchSettings);
      const settingsPresentation = await page.evaluate(() => ({
        denied: document.body.innerText.includes("Access denied"),
        form: !!document.querySelector('input[placeholder="My Business"]'),
        save: [...document.querySelectorAll("button")].some(
          (button) => button.textContent.trim() === "Save"
        ),
        navigation: !!document.querySelector('nav a[href="/settings"]'),
      }));
      L.assert(
        permittedAdmin
          ? settingsPresentation.form &&
              settingsPresentation.save &&
              settingsPresentation.navigation &&
              !settingsPresentation.denied
          : settingsPresentation.denied &&
              !settingsPresentation.form &&
              !settingsPresentation.save &&
              !settingsPresentation.navigation,
        `${role}: actual Settings page/navigation matches server permission`
      );
      if (!permittedAdmin)
        L.assert(
          settingsRequests.length === 0,
          `${role}: denied Settings mounts no protected fetch`
        );
      results.at(-1).settingsPage = settingsPresentation;
      await L.shot(page, "j21-settings-" + role);
    }
    await inspect(owner, "owner");
    for (let index = 0; index < accounts.length; index++) {
      const account = accounts[index],
        browser = await L.launch(`j21-${account.role}-${suffix}`);
      browsers.push(browser);
      const page = await browser.newPage(),
        events = L.watch(page, "j21-" + account.role);
      await page.setExtraHTTPHeaders({ "X-Forwarded-For": `198.51.100.${230 + index}` });
      await page.goto(L.BASE + "/login", { waitUntil: "networkidle0" });
      await page.type("#username", account.username);
      await page.type("#password", account.password);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle0" }),
        page.click('button[type="submit"]'),
      ]);
      await page.waitForSelector('header button[aria-label^="Account menu"]');
      L.assert(!page.url().includes("/login"), `${account.role}: actual login succeeds`);
      await inspect(page, account.role);
      L.assert(events.pageErrors.length === 0, `${account.role}: no browser runtime exception`);
      await browser.close();
      browsers.pop();
    }
    L.finish("J21-workspace-role-matrix", {
      platformBoundary: { role: platformRole, ungrantedWorkspaceStatus: platformForeignStatus },
      fixture:
        "Actual secured workspace user UI and real login; full-workspace scope, no P3 invitations or platform operator/support claim",
      results,
    });
  } finally {
    for (const browser of browsers.reverse()) await browser.close();
  }
})().catch((error) => {
  console.error("ERR", error.message);
  process.exitCode = 1;
});
