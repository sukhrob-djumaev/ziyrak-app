// P1 Administration lifetime/read-order acceptance after J22. Real product
// provisioning/login/key/user actions. Restricted scope and extra membership are
// controlled DB prerequisites, not scope-assignment or P3 invitation UI evidence.
const L = require("./lib.cjs"),
  creds = require("./creds.json");
const { randomUUID } = require("node:crypto");
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const suffix = randomUUID().slice(0, 8);
async function mutation(page, path, method, action, status) {
  const pending = page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.request().method() === method
  );
  await action();
  const response = await pending;
  L.assert(response.status() === status, `${method} ${path} actual UI response ${status}`);
  return response;
}
async function createUser(owner, role, label) {
  const input = {
    username: `j23_${label}_${suffix}`,
    password: "Synthetic-" + randomUUID(),
    name: `Synthetic ${label} ${suffix}`,
    role,
  };
  await L.clickFirst(owner, "button", "Add User");
  await owner.waitForSelector('input[placeholder="Full name"]');
  await owner.type('input[placeholder="Full name"]', input.name);
  await owner.type('input[placeholder="Username for login"]', input.username);
  await owner.type('input[placeholder="Minimum 6 characters"]', input.password);
  await owner.select(".fixed select", role);
  const response = await mutation(
    owner,
    "/api/admin/users",
    "POST",
    () => L.clickLast(owner, "button", "Create User"),
    201
  );
  const saved = await response.json();
  await owner.waitForFunction(
    () => !document.querySelector('input[placeholder="Username for login"]')
  );
  L.assert(
    saved.userId && saved.id && saved.role === role,
    "Actual UI provisioned expected membership/account"
  );
  return { ...input, ...saved };
}
async function login(browser, account, ip) {
  const page = await browser.newPage(),
    errors = L.watch(page, "j23-" + account.role);
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": ip });
  await page.goto(L.BASE + "/login", { waitUntil: "load" });
  await page.waitForSelector("#username");
  await page.type("#username", account.username);
  await page.type("#password", account.password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.click('button[type="submit"]'),
  ]);
  await page.goto(L.BASE + "/admin", { waitUntil: "load" });
  await page.waitForSelector("table tbody tr");
  return { page, errors };
}
async function refreshContext(page) {
  const pending = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/admin" &&
      (r.headers()["content-type"] || "").includes("text/x-component")
  );
  // Controlled real same-route Next Link refresh while a dialog overlays it.
  await page.evaluate(() => document.querySelector('nav a[href="/admin"]').click());
  await pending;
}
async function keyFlow(page, { actorId, businessId, connectionId, holdInitial = false }) {
  let cdp,
    first,
    reads = 0,
    paused,
    settledRead,
    readOutcome = null,
    continuationErrors = 0;
  if (holdInitial) {
    cdp = await page.createCDPSession();
    let release;
    paused = new Promise((resolve) => (release = resolve));
    let settle;
    settledRead = new Promise((resolve) => (settle = resolve));
    const outcomes = new Map();
    const finished = (event, kind) => {
      const outcome = { kind };
      outcomes.set(event.requestId, outcome);
      if (event.requestId === first?.networkId) settle(outcome);
    };
    cdp.on("Network.loadingFinished", (event) => finished(event, "completed"));
    cdp.on("Network.loadingFailed", (event) =>
      finished(
        event,
        event.canceled || event.errorText === "net::ERR_ABORTED" ? "cancelled" : "failed"
      )
    );
    await cdp.send("Network.enable");
    cdp.on("Fetch.requestPaused", async (event) => {
      if (
        event.request.method === "GET" &&
        new URL(event.request.url).pathname === "/api/admin/api-keys" &&
        ++reads === 1
      ) {
        first = event;
        L.assert(!!first.networkId, "Held response has an observable network identity");
        if (outcomes.has(first.networkId)) settle(outcomes.get(first.networkId));
        release();
        return;
      }
      await cdp.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {
        ++continuationErrors;
      });
    });
    await cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: L.BASE + "/api/admin/api-keys*", requestStage: "Response" }],
    });
    await page.goto(L.BASE + "/admin", { waitUntil: "load" });
    await paused;
    L.assert(first.responseStatusCode === 200, "Held actual initial key read was authorized");
  }
  await L.clickFirst(page, "button", "API Keys");
  await L.clickFirst(page, "button", "Generate New Key");
  await page.waitForSelector('input[placeholder="e.g. Production API, Webhook Integration"]');
  const name = `Synthetic J23 key ${suffix} ${connectionId ? "restricted" : "full"}`;
  await page.type('input[placeholder="e.g. Production API, Webhook Integration"]', name);
  const response = await mutation(
    page,
    "/api/admin/api-keys",
    "POST",
    () => L.clickLast(page, "button", "Generate Key"),
    201
  );
  const saved = await response.json();
  L.assert(
    typeof saved.key === "string" && saved.key.length > 20,
    "Actual UI receives one-time generated key"
  );
  await page.waitForFunction(() => !!document.querySelector(".fixed code"));
  L.assert(
    await page.$eval(".fixed code", (el, expected) => el.textContent === expected, saved.key),
    "The actual issued one-time key is visible in its dedicated dialog"
  );
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll("table tbody tr")].some((row) =>
        row.textContent.includes(name)
      ),
    {},
    name
  );
  if (holdInitial) {
    L.assert(reads >= 2, "New key read completed after creation while initial read was held");
    let releaseError = false,
      timeout;
    await cdp.send("Fetch.continueRequest", { requestId: first.requestId }).catch(() => {
      releaseError = true;
    });
    try {
      readOutcome = await Promise.race([
        settledRead,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Old key read never completed or cancelled")),
            10_000
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    L.assert(
      readOutcome.kind === "completed" || readOutcome.kind === "cancelled",
      "Old key read explicitly completed or was cancelled"
    );
    L.assert(
      !releaseError || readOutcome.kind === "cancelled",
      "Held response release failure only accepted after observed cancellation"
    );
    L.assert(
      continuationErrors === 0,
      "Other intercepted responses continued without hidden protocol errors"
    );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    L.assert(
      await page.$$eval(
        "table tbody tr",
        (rows, name) => rows.some((row) => row.textContent.includes(name)),
        name
      ),
      "Older key response cannot erase the newly created key row"
    );
    await cdp.send("Fetch.disable");
    await cdp.detach();
  }
  const snapshot = JSON.parse(
    L.sql(
      'SELECT json_build_object(\'businessId\',"businessId",\'issuer\',"issuedByUserId",\'role\',role,\'mode\',"scopeMode",\'profile\',"customerProfileAccess",\'origin\',"scopeOrigin",\'connections\',(SELECT coalesce(json_agg("connectionId" ORDER BY "connectionId"),\'[]\') FROM "ApiKeyConnectionScope" WHERE "apiKeyId"=' +
        quote(saved.id) +
        ')) FROM "ApiKey" WHERE id=' +
        quote(saved.id)
    )
  );
  L.assert(
    snapshot.businessId === businessId &&
      snapshot.issuer === actorId &&
      snapshot.role === "agent" &&
      snapshot.origin === "issuer",
    "Key has actual issuer/workspace and capped role"
  );
  L.assert(
    connectionId
      ? snapshot.mode === "connections" &&
          snapshot.profile === "none" &&
          JSON.stringify(snapshot.connections) === JSON.stringify([connectionId])
      : snapshot.mode === "workspace" && snapshot.profile === "write",
    "Key preserves current scope ceiling"
  );
  // Never screenshot, print or save the generated secret.
  await L.clickLast(page, "button", "Done");
  await page.waitForFunction(() => !document.querySelector(".fixed code"));
  L.assert(
    await page.$$eval(
      "table tbody tr",
      (rows, { name, prefix, secret }) => {
        const row = rows.find((row) => row.textContent.includes(name));
        return (
          row?.querySelector("code")?.textContent === prefix &&
          !document.body.innerText.includes(secret)
        );
      },
      { name, prefix: saved.keyPrefix, secret: saved.key }
    ),
    "After dismissing the one-time dialog, only the safe prefix is displayed"
  );
  const clickRow = (title) =>
    page.evaluate(
      ({ name, title }) => {
        const row = [...document.querySelectorAll("table tbody tr")].find((row) =>
          row.textContent.includes(name)
        );
        row.querySelector(`button[title="${title}"]`).click();
      },
      { name, title }
    );
  await mutation(page, "/api/admin/api-keys/" + saved.id, "PUT", () => clickRow("Deactivate"), 200);
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll("table tbody tr")]
        .find((row) => row.textContent.includes(name))
        ?.textContent.includes("Inactive"),
    {},
    name
  );
  L.assert(
    L.sql('SELECT "isActive" FROM "ApiKey" WHERE id=' + quote(saved.id)) === "f",
    "Deactivated key persisted"
  );
  await mutation(page, "/api/admin/api-keys/" + saved.id, "PUT", () => clickRow("Activate"), 200);
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll("table tbody tr")]
        .find((row) => row.textContent.includes(name))
        ?.textContent.includes("Active"),
    {},
    name
  );
  await clickRow("Delete key");
  await page.waitForSelector(".fixed");
  await mutation(
    page,
    "/api/admin/api-keys/" + saved.id,
    "DELETE",
    () => L.clickLast(page, "button", "Delete"),
    200
  );
  await page.waitForFunction(
    (name) =>
      ![...document.querySelectorAll("table tbody tr")].some((row) =>
        row.textContent.includes(name)
      ),
    {},
    name
  );
  L.assert(
    L.sql('SELECT count(*) FROM "ApiKey" WHERE id=' + quote(saved.id)) === "0",
    "Deleted key no longer persisted"
  );
  return {
    scope: snapshot.mode,
    profile: snapshot.profile,
    heldRead: holdInitial,
    oldReadOutcome: readOutcome?.kind ?? null,
  };
}
(async () => {
  const browsers = [];
  try {
    const ownerBrowser = await L.launch(creds.A.profile);
    browsers.push(ownerBrowser);
    const owner = await ownerBrowser.newPage();
    await owner.goto(L.BASE + "/admin", { waitUntil: "networkidle0" });
    await owner.waitForSelector("table tbody tr");
    const a = L.sql(
      'SELECT m."businessId" FROM "Membership" m JOIN "User" u ON u.id=m."userId" WHERE u.username=' +
        quote(creds.A.user) +
        " AND m.role='owner'"
    );
    const b = L.sql(
      'SELECT m."businessId" FROM "Membership" m JOIN "User" u ON u.id=m."userId" WHERE u.username=' +
        quote(creds.B.user) +
        " AND m.role='owner'"
    );
    const connection = L.sql(
      'SELECT id FROM "ChannelConnection" WHERE "businessId"=' + quote(a) + " ORDER BY id LIMIT 1"
    );
    L.assert(a && b && connection, "Actual two-workspace fixtures and connection exist");
    const admin = await createUser(owner, "admin", "admin"),
      restricted = await createUser(owner, "admin", "restricted");
    const adminBrowser = await L.launch("j23-admin-" + suffix);
    browsers.push(adminBrowser);
    const first = await login(adminBrowser, admin, "198.51.100.241");
    const fullKey = await keyFlow(first.page, { actorId: admin.userId, businessId: a });
    await L.clickFirst(first.page, "button", "Users");
    await first.page.waitForSelector("table tbody tr");
    // Duplicate username returns a real nested409 error. It must render text,
    // keep the allowed dialog usable and produce no React object-render exception.
    await L.clickFirst(first.page, "button", "Add User");
    await first.page.type('input[placeholder="Full name"]', "Synthetic duplicate");
    await first.page.type('input[placeholder="Username for login"]', admin.username);
    await first.page.type('input[placeholder="Minimum 6 characters"]', "Synthetic-" + randomUUID());
    await mutation(
      first.page,
      "/api/admin/users",
      "POST",
      () => L.clickLast(first.page, "button", "Create User"),
      409
    );
    await first.page.waitForFunction(() =>
      document.body.innerText.includes("Username already exists")
    );
    L.assert(
      first.errors.pageErrors.length === 0,
      "Nested error renders readable text without exception"
    );
    await L.clickLast(first.page, "button", "Cancel");
    await L.clickFirst(first.page, "button", "Add User");
    await first.page.type('input[placeholder="Full name"]', "Synthetic denied actor");
    await first.page.type('input[placeholder="Username for login"]', "j23_denied_" + suffix);
    await first.page.type('input[placeholder="Minimum 6 characters"]', "Synthetic-" + randomUUID());
    await owner.evaluate(
      (username) =>
        [...document.querySelectorAll("table tbody tr")]
          .find((row) => row.textContent.includes(username))
          .querySelector('button[title="Edit user"]')
          .click(),
      admin.username
    );
    await owner.waitForSelector(".fixed select");
    await owner.select(".fixed select", "viewer");
    await mutation(
      owner,
      "/api/admin/users/" + admin.id,
      "PUT",
      () => L.clickLast(owner, "button", "Save Changes"),
      200
    );
    await mutation(
      first.page,
      "/api/admin/users",
      "POST",
      () => L.clickLast(first.page, "button", "Create User"),
      403
    );
    await first.page.waitForFunction(
      () =>
        document.body.innerText.includes("Access denied") ||
        ["/login", "/workspaces"].includes(location.pathname)
    );
    await first.page.waitForFunction(() => !document.querySelector('nav a[href="/admin"]'));
    L.assert(
      (await first.page.$$eval("table tbody tr", (rows) => rows.length)) === 0 &&
        !(await first.page.$(".fixed input")),
      "Rejected mutation clears protected rows/dialog/password"
    );
    L.assert(
      !(await first.page.$('nav a[href="/admin"]')),
      "Revoked Administration navigation disappears after server refresh"
    );
    await L.shot(first.page, "j23-demoted-admin-denied");
    const restrictedBrowser = await L.launch("j23-restricted-" + suffix);
    browsers.push(restrictedBrowser);
    const second = await login(restrictedBrowser, restricted, "198.51.100.242");
    await L.clickFirst(second.page, "button", "Add User");
    await second.page.type(
      'input[placeholder="Minimum 6 characters"]',
      "Synthetic-unsubmitted-input"
    );
    L.sql(
      'UPDATE "Membership" SET "scopeMode"=\'connections\',"customerProfileAccess"=\'none\' WHERE id=' +
        quote(restricted.id)
    );
    L.sql(
      'INSERT INTO "MembershipConnectionScope" ("businessId","membershipId","connectionId") VALUES (' +
        [a, restricted.id, connection].map(quote).join(",") +
        ")"
    );
    await refreshContext(second.page);
    await second.page.waitForFunction(
      () =>
        ![...document.querySelectorAll("button")].some(
          (button) => button.textContent.trim() === "Add User"
        )
    );
    L.assert(
      !(await second.page.$('input[placeholder="Minimum 6 characters"]')),
      "Scope refresh unmounts dialog/password"
    );
    L.assert(
      (await L.text(second.page)).includes("API Keys") &&
        !(await L.text(second.page)).includes("Access denied"),
      "Restricted admin retains permitted Administration reads/key UI"
    );
    const scopedKey = await keyFlow(second.page, {
      actorId: restricted.userId,
      businessId: a,
      connectionId: connection,
      holdInitial: true,
    });
    await L.clickFirst(second.page, "button", "Generate New Key");
    await second.page.waitForSelector(
      'input[placeholder="e.g. Production API, Webhook Integration"]'
    );
    await second.page.type(
      'input[placeholder="e.g. Production API, Webhook Integration"]',
      "Synthetic old workspace form"
    );
    L.sql(
      'INSERT INTO "Membership" (id,"businessId","userId",role,"updatedAt") VALUES (' +
        [randomUUID(), b, restricted.userId, "admin"].map(quote).join(",") +
        ",now())"
    );
    const selected = await second.page.evaluate(
      async (workspaceId) =>
        (
          await fetch("/api/workspaces", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId }),
          })
        ).status,
      b
    );
    L.assert(selected === 200, "Actual signed workspace selector admits current B membership");
    await refreshContext(second.page);
    await second.page.waitForFunction(
      (username) =>
        [...document.querySelectorAll("table tbody tr")].some((row) =>
          row.textContent.includes(username)
        ),
      {},
      creds.B.user
    );
    L.assert(
      !(await second.page.$('input[placeholder="e.g. Production API, Webhook Integration"]')),
      "Workspace refresh discards old key form"
    );
    L.assert(
      !(await second.page.$$eval(
        "table tbody tr",
        (rows, username) => rows.some((row) => row.textContent.includes(username)),
        creds.A.user
      )),
      "Same-capability workspace change cannot retain previous workspace rows"
    );
    await L.shot(second.page, "j23-selected-workspace-reset");
    L.assert(
      first.errors.pageErrors.length === 0 && second.errors.pageErrors.length === 0,
      "No browser runtime exceptions"
    );
    L.finish("J23-administration-ui", {
      fullKey,
      scopedKey,
      scopeRefreshClearsDialog: true,
      workspaceRefreshClearsRowsAndForm: true,
      demotionRejectsAndClears: true,
      nestedErrorText: true,
      limitations:
        "local topology/synthetic accounts; scope and second membership seeded prerequisites; controlled same-route RSC refresh; no invitation/provider claim",
    });
  } finally {
    for (const browser of browsers.reverse()) await browser.close();
  }
})().catch((error) => {
  console.error("J23: " + error.message);
  process.exitCode = 1;
});
