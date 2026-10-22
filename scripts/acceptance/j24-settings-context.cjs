// P1 Settings UI. Synthetic accounts; scope/extra membership/default slug are
// controlled prerequisites. Legacy500 is an injected UI fault, not provider proof.
const L = require("./lib.cjs"),
  creds = require("./creds.json");
const { randomUUID } = require("node:crypto");
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const suffix = randomUUID().slice(0, 8);
const welcome = 'textarea[placeholder="Hello! How can I help you today?"]';
async function mutation(page, endpoint, method, action, status) {
  const pending = page.waitForResponse(
    (r) => new URL(r.url()).pathname === endpoint && r.request().method() === method
  );
  pending.catch(() => {});
  await action();
  const response = await pending;
  L.assert(response.status() === status, `Actual UI ${method} ${endpoint} returns ${status}`);
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("button")].some(
        (button) =>
          button.disabled && ["Saving...", "Creating..."].includes(button.textContent.trim())
      )
  );
  return response;
}
async function replace(page, selector, value) {
  await page.$eval(selector, (el) => { el.focus(); el.select(); });
  await page.keyboard.press("Backspace");
  await page.type(selector, value);
}
async function settings(page) {
  await page.goto(L.BASE + "/settings", { waitUntil: "networkidle0" });
  await page.waitForSelector('input[placeholder="My Business"]');
}
async function login(browser, account, ip) {
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": ip });
  await page.goto(L.BASE + "/login", { waitUntil: "load" });
  await page.waitForSelector("#username");
  await page.type("#username", account.username);
  await page.type("#password", account.password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.click('button[type="submit"]'),
  ]);
  return page;
}
async function choose(page, workspaceId) {
  const name = L.sql('SELECT name FROM "Business" WHERE id=' + quote(workspaceId));
  await page.goto(L.BASE + "/workspaces", { waitUntil: "networkidle0" });
  await page.waitForFunction(
    (name) => [...document.querySelectorAll("button")].some((b) => b.textContent.includes(name)),
    {},
    name
  );
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.evaluate(
      (name) =>
        [...document.querySelectorAll("button")].find((b) => b.textContent.includes(name)).click(),
      name
    ),
  ]);
}
async function provisionAdmin(owner) {
  const input = {
    username: "j24_admin_" + suffix,
    password: "Synthetic-" + randomUUID(),
    name: "Synthetic Settings admin " + suffix,
  };
  const saved = await L.inviteViaUi(owner, { ...input, role: "admin" });
  L.assert(saved.id && saved.userId && saved.role === "admin", "Real UI created scoped membership/account");
  return { ...input, ...saved };
}
async function lateReadContext(page, switcher, a, b, expectedB) {
  await choose(page, a);
  const cdp = await page.createCDPSession();
  let first,
    release,
    settle,
    continuationErrors = 0;
  const paused = new Promise((resolve) => (release = resolve)),
    settled = new Promise((resolve) => (settle = resolve));
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
      !first &&
      event.request.method === "GET" &&
      new URL(event.request.url).pathname === "/api/settings/business"
    ) {
      first = event;
      L.assert(
        !!first.networkId && first.responseStatusCode === 200,
        "Held actual A profile read is authorized and observable"
      );
      if (outcomes.has(first.networkId)) settle(outcomes.get(first.networkId));
      release();
      return;
    }
    await cdp
      .send("Fetch.continueRequest", { requestId: event.requestId })
      .catch(() => ++continuationErrors);
  });
  await cdp.send("Fetch.enable", {
    patterns: [{ urlPattern: L.BASE + "/api/settings/business*", requestStage: "Response" }],
  });
  try {
    await page.goto(L.BASE + "/settings", { waitUntil: "load" });
    let pausedTimer;
    try {
      await Promise.race([
        paused,
        new Promise(
          (_, reject) =>
            (pausedTimer = setTimeout(
              () => reject(Error("Initial profile read did not pause")),
              15000
            ))
        ),
      ]);
    } finally {
      clearTimeout(pausedTimer);
    }
    await choose(switcher, b);
    await page.bringToFront();
    const refreshed = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/settings" &&
        (r.headers()["content-type"] || "").includes("text/x-component")
    );
    // Controlled same-route real Next Link refresh while the old read is held.
    await page.evaluate(() => document.querySelector('nav a[href="/settings"]').click());
    await refreshed;
    await page.waitForFunction(
      (selector, expected) => document.querySelector(selector)?.value === expected,
      {},
      welcome,
      expectedB
    );
    let releaseError = false,
      timer,
      outcome;
    await cdp
      .send("Fetch.continueRequest", { requestId: first.requestId })
      .catch(() => (releaseError = true));
    try {
      outcome = await Promise.race([
        settled,
        new Promise(
          (_, reject) =>
            (timer = setTimeout(() => reject(Error("Old profile read never settled")), 10000))
        ),
      ]);
    } finally {
      clearTimeout(timer);
    }
    L.assert(
      ["completed", "cancelled"].includes(outcome.kind) &&
        (!releaseError || outcome.kind === "cancelled"),
      "Old profile completion/cancellation explicitly observed"
    );
    L.assert(continuationErrors === 0, "Other held-read continuations succeeded");
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    L.assert(
      await page.$eval(welcome, (el, expected) => el.value === expected, expectedB),
      "Late A read cannot replace refreshed B profile"
    );
    return outcome.kind;
  } finally {
    await cdp.send("Fetch.disable").catch(() => {});
    await cdp.detach();
  }
}
(async () => {
  const browsers = [];
  try {
    const ownerBrowser = await L.launch(creds.A.profile);
    browsers.push(ownerBrowser);
    const owner = await ownerBrowser.newPage();
    await owner.goto(L.BASE + "/admin", { waitUntil: "networkidle0" });
    const find = (c) =>
      L.sql(
        'SELECT m."businessId" FROM "Membership" m JOIN "User" u ON u.id=m."userId" WHERE u.username=' +
          quote(c.user) +
          " AND m.role='owner'"
      );
    const a = find(creds.A),
      b = find(creds.B),
      admin = await provisionAdmin(owner);
    const browser = await L.launch("j24-settings-" + suffix);
    browsers.push(browser);
    const page = await login(browser, admin, "198.51.100.248"),
      errors = L.watch(page, "j24-settings");
    let legacyReads = 0;
    const watchLegacy = (request) => {
      if (new URL(request.url()).pathname === "/api/settings") ++legacyReads;
    };
    page.on("request", watchLegacy);
    await settings(page);
    L.assert(
      legacyReads === 0 && !(await L.text(page)).includes("Phone (Twilio)"),
      "Nondefault workspace never probes/enables legacy settings"
    );
    page.off("request", watchLegacy);
    const normal = "Synthetic Settings normal " + suffix;
    await replace(page, welcome, normal);
    await mutation(
      page,
      "/api/settings/business",
      "PUT",
      () => L.clickFirst(page, "button", "Save"),
      200
    );
    L.assert(
      L.sql('SELECT "welcomeMessage" FROM "BusinessConfig" WHERE "businessId"=' + quote(a)) ===
        normal,
      "Normal actual profile save persists A"
    );
    L.sql(
      'INSERT INTO "Membership" (id,"businessId","userId",role,"scopeMode","customerProfileAccess") VALUES (' +
        [randomUUID(), b, admin.userId, "admin", "workspace", "write"].map(quote).join(",") +
        ")"
    );
    const expectedB = L.sql(
      'SELECT "welcomeMessage" FROM "BusinessConfig" WHERE "businessId"=' + quote(b)
    );
    const wrong = "Synthetic old A form " + suffix;
    await replace(page, welcome, wrong);
    const switcher = await browser.newPage();
    await choose(switcher, b);
    await page.bringToFront();
    const rejected = await mutation(
      page,
      "/api/settings/business",
      "PUT",
      () => L.clickFirst(page, "button", "Save"),
      403
    );
    L.assert(
      rejected.request().headers()["x-workspace-id"] === a,
      "Original Settings form still names rendered A"
    );
    L.assert(
      L.sql('SELECT count(*) FROM "BusinessConfig" WHERE "welcomeMessage"=' + quote(wrong)) === "0",
      "Cross-tab conflict writes neither workspace"
    );
    await page.waitForFunction(
      (selector, value) => document.querySelector(selector)?.value === value,
      {},
      welcome,
      expectedB
    );
    await L.shot(page, "j24-cross-tab-context-reset");
    const oldReadOutcome = await lateReadContext(page, switcher, a, b, expectedB);
    await choose(page, a);
    const connection = L.sql(
      'SELECT id FROM "ChannelConnection" WHERE "businessId"=' + quote(a) + " ORDER BY id LIMIT 1"
    );
    L.assert(!!connection, "Existing A channel for controlled restricted admin prerequisite");
    L.sql(
      'UPDATE "Membership" SET "scopeMode"=\'connections\',"customerProfileAccess"=\'none\' WHERE id=' +
        quote(admin.id)
    );
    L.sql(
      'INSERT INTO "MembershipConnectionScope" ("businessId","membershipId","connectionId") VALUES (' +
        [a, admin.id, connection].map(quote).join(",") +
        ")"
    );
    await settings(page);
    const restricted = "Synthetic restricted Settings " + suffix;
    await replace(page, welcome, restricted);
    await mutation(
      page,
      "/api/settings/business",
      "PUT",
      () => L.clickFirst(page, "button", "Save"),
      200
    );
    L.assert(
      L.sql('SELECT "welcomeMessage" FROM "BusinessConfig" WHERE "businessId"=' + quote(a)) ===
        restricted,
      "Restricted admin preserves existing legitimate Settings write"
    );
    await L.clickFirst(page, "button", "AI Configuration");
    await page.waitForSelector('input[type="password"]');
    await page.type('input[type="password"]', "Synthetic-never-submit-" + randomUUID());
    await owner.waitForFunction(
      (username) =>
        [...document.querySelectorAll("table tbody tr")].some((row) =>
          row.textContent.includes(username)
        ),
      {},
      admin.username
    );
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
      page,
      "/api/settings/ai",
      "PUT",
      () => L.clickFirst(page, "button", "Save"),
      403
    );
    await page.waitForFunction(
      () =>
        document.body.innerText.includes("Access denied") &&
        !document.querySelector('input[type="password"]') &&
        !document.querySelector('nav a[href="/settings"]')
    );
    L.assert(
      !(await page.$("input,textarea")),
      "Demotion clears all Settings form/credential inputs"
    );
    await L.shot(page, "j24-demotion-denied");

    // Last journey: create a synthetic Default Business through product signup,
    // then assign only its reserved slug as a controlled legacy prerequisite.
    L.assert(
      L.sql("SELECT count(*) FROM \"Business\" WHERE slug='default'") === "0",
      "Fresh full run has no preexisting Default Business"
    );
    const account = { username: "j24_legacy_" + suffix, password: "Synthetic-" + randomUUID() };
    const legacyEmail = `j24_legacy_${suffix}@example.test`;
    const signup = await fetch(L.BASE + "/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.249" },
      body: JSON.stringify({
        action: "signup",
        ...account,
        email: legacyEmail,
        name: "Synthetic legacy owner",
        businessName: "Synthetic legacy " + suffix,
      }),
    });
    // P3: signup answers 202 and signs nobody in.
    L.assert(
      signup.status === 202,
      "Synthetic legacy owner provisioned through product signup API"
    );
    const legacyId = L.sql(
      'SELECT m."businessId" FROM "Membership" m JOIN "User" u ON u.id=m."userId" WHERE u.username=' +
        quote(account.username)
    );
    // The default workspace is a legacy, activated workspace: this prerequisite confirms the address
    // through the real verification link and marks onboarding done so Settings is reachable as before.
    const legacyMail = await L.waitForMail(legacyEmail, { match: /verify-email/ });
    const confirmed = await fetch(L.BASE + "/api/auth/verify-email", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.248" },
      body: JSON.stringify({ token: legacyMail.token }),
    });
    L.assert(confirmed.ok, "Legacy owner confirmed the emailed link");
    L.sql('UPDATE "WorkspaceAiAllowance" SET mode=\'legacy_byok\', status=\'active\' WHERE "businessId"=' + quote(legacyId));
    L.sql('UPDATE "OnboardingState" SET "activatedAt"=now() WHERE "businessId"=' + quote(legacyId));
    L.sql("UPDATE \"Business\" SET slug='default' WHERE id=" + quote(legacyId));
    const legacyBrowser = await L.launch("j24-legacy-" + suffix);
    browsers.push(legacyBrowser);
    const legacy = await login(legacyBrowser, account, "198.51.100.250"),
      legacyErrors = L.watch(legacy, "j24-legacy");
    await settings(legacy);
    await L.clickFirst(legacy, "button", "Email (SMTP/IMAP)");
    const smtp = "Synthetic-smtp-" + randomUUID(),
      imap = "Synthetic-imap-" + randomUUID();
    await replace(legacy, 'input[placeholder="smtp.gmail.com"]', "synthetic-original.invalid");
    await replace(legacy, 'input[placeholder="Enter SMTP password"]', smtp);
    await replace(legacy, 'input[placeholder="Enter IMAP password"]', imap);
    await mutation(
      legacy,
      "/api/settings",
      "PUT",
      () => L.clickFirst(legacy, "button", "Save"),
      200
    );
    await settings(legacy);
    await L.clickFirst(legacy, "button", "Email (SMTP/IMAP)");
    await replace(legacy, 'input[placeholder="smtp.gmail.com"]', "synthetic-edited.invalid");
    const unrelated = await mutation(
      legacy,
      "/api/settings",
      "PUT",
      () => L.clickFirst(legacy, "button", "Save"),
      200
    );
    const submitted = JSON.parse(unrelated.request().postData());
    L.assert(
      !Object.hasOwn(submitted, "smtpPass") && !Object.hasOwn(submitted, "imapPass"),
      "Unrelated legacy save submits no display masks or untouched secret fields"
    );
    L.assert(
      L.sql(
        'SELECT ("smtpPass"=' +
          quote(smtp) +
          ' AND "imapPass"=' +
          quote(imap) +
          ") FROM \"Settings\" WHERE id='default'"
      ) === "true",
      "Actual nonsecret save preserves both stored synthetic secrets"
    );
    const rotated = "Synthetic-rotated-" + randomUUID();
    await replace(legacy, 'input[placeholder="Enter SMTP password"]', rotated);
    await mutation(
      legacy,
      "/api/settings",
      "PUT",
      () => L.clickFirst(legacy, "button", "Save"),
      200
    );
    await legacy.waitForFunction(
      (secret) =>
        document.querySelector('input[placeholder="Enter SMTP password"]')?.value !== secret,
      {},
      rotated
    );
    L.assert(
      L.sql(
        'SELECT ("smtpPass"=' +
          quote(rotated) +
          ' AND "imapPass"=' +
          quote(imap) +
          ") FROM \"Settings\" WHERE id='default'"
      ) === "true",
      "Explicit credential replacement preserves untouched credential"
    );
    await legacy.$eval('input[placeholder="Enter SMTP password"]', (el) => { el.focus(); el.select(); });
    await legacy.keyboard.press("Backspace");
    await mutation(
      legacy,
      "/api/settings",
      "PUT",
      () => L.clickFirst(legacy, "button", "Save"),
      200
    );
    L.assert(
      L.sql(
        'SELECT ("smtpPass"=\'\' AND "imapPass"=' +
          quote(imap) +
          ") FROM \"Settings\" WHERE id='default'"
      ) === "true",
      "Explicit credential clear preserves untouched credential"
    );
    await replace(legacy, 'input[placeholder="smtp.gmail.com"]', "synthetic-after-clear.invalid");
    const afterClear = await mutation(
      legacy,
      "/api/settings",
      "PUT",
      () => L.clickFirst(legacy, "button", "Save"),
      200
    );
    const afterClearBody = JSON.parse(afterClear.request().postData());
    L.assert(
      !Object.hasOwn(afterClearBody, "smtpPass") &&
        !Object.hasOwn(afterClearBody, "imapPass") &&
        L.sql(
          'SELECT ("smtpPass"=\'\' AND "imapPass"=' +
            quote(imap) +
            ") FROM \"Settings\" WHERE id='default'"
        ) === "true",
      "Unrelated save after clear omits untouched empty/masked credentials"
    );
    let injected = false;
    await legacy.setRequestInterception(true);
    const fault = async (request) => {
      if (
        !injected &&
        request.method() === "GET" &&
        new URL(request.url()).pathname === "/api/settings"
      ) {
        injected = true;
        await request.respond({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Synthetic legacy read failure" }),
        });
      } else await request.continue();
    };
    legacy.on("request", fault);
    await legacy.goto(L.BASE + "/settings", { waitUntil: "networkidle0" });
    await legacy.waitForFunction(() =>
      document.body.innerText.includes("Settings could not be loaded")
    );
    L.assert(
      injected &&
        !(await legacy.$("input,textarea")) &&
        !(await L.text(legacy)).includes("Phone (Twilio)"),
      "Injected legacy500 enables no Settings forms or legacy panels"
    );
    await L.clickFirst(legacy, "button", "Retry");
    await legacy.waitForFunction(() =>
      [...document.querySelectorAll("button")].some((b) => b.textContent.includes("Phone (Twilio)"))
    );
    L.assert(
      !!(await legacy.$('input[placeholder="My Business"]')),
      "Actual successful current legacy read recovers through Retry"
    );
    legacy.off("request", fault);
    await legacy.setRequestInterception(false);
    await L.shot(legacy, "j24-legacy-retry-recovered");
    L.assert(
      errors.pageErrors.length === 0 && legacyErrors.pageErrors.length === 0,
      "No Settings browser runtime exceptions"
    );
    L.finish("J24-settings-context", {
      oldReadOutcome,
      crossTabNoMutation: true,
      restrictedAdminPositive: true,
      demotionClearsCredentials: true,
      legacyNonsecretPreservesSecrets: true,
      explicitLegacyRotation: true,
      explicitLegacyClear: true,
      legacyFailureRetry: true,
      limitations:
        "synthetic local topology; scope/second membership/default slug controlled; same-route RSC refresh and injected legacy500; product signup prerequisite, no invitation/managed-AI/provider proof",
    });
  } finally {
    for (const browser of browsers.reverse()) await browser.close();
  }
})().catch((error) => {
  console.error("J24: " + (error.stack || error.message));
  process.exitCode = 1;
});
