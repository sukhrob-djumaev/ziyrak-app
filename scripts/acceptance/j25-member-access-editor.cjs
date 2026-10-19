// P1 member access editor acceptance. Real product provisioning, real Administration UI edit,
// real member login. A second ChannelConnection is a controlled DB prerequisite (not channel
// setup evidence). No invitation or provider claim.
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
async function openEdit(owner, username) {
  await owner.evaluate(
    (name) =>
      [...document.querySelectorAll("table tbody tr")]
        .find((row) => row.textContent.includes(name))
        .querySelector('button[title="Edit user"]')
        .click(),
    username
  );
  await owner.waitForSelector('fieldset[aria-label="Channel access"]');
}
(async () => {
  const browsers = [];
  try {
    const ownerBrowser = await L.launch(creds.A.profile);
    browsers.push(ownerBrowser);
    const owner = await ownerBrowser.newPage();
    const errors = L.watch(owner, "j25-owner");
    await owner.goto(L.BASE + "/admin", { waitUntil: "networkidle0" });
    await owner.waitForSelector("table tbody tr");
    const a = L.sql(
      'SELECT m."businessId" FROM "Membership" m JOIN "User" u ON u.id=m."userId" WHERE u.username=' +
        quote(creds.A.user) +
        " AND m.role='owner'"
    );
    const kept = L.sql(
      'SELECT id FROM "ChannelConnection" WHERE "businessId"=' + quote(a) + " ORDER BY id LIMIT 1"
    );
    // A different type from the existing connection: the legacy channel list keeps one entry per type.
    const keptType = L.sql('SELECT type FROM "ChannelConnection" WHERE id=' + quote(kept));
    const otherType = keptType === "sms" ? "phone" : "sms";
    const other = randomUUID();
    L.sql(
      'INSERT INTO "ChannelConnection" (id,"businessId",type,name,"updatedAt") VALUES (' +
        [other, a, otherType, "J25 second channel " + suffix].map(quote).join(",") +
        ",now())"
    );
    L.assert(a && kept && keptType, "Workspace and a pre-existing connection exist");
    // Provision a member through the real UI.
    const member = {
      username: `j25_agent_${suffix}`,
      password: "Synthetic-" + randomUUID(),
      name: `Synthetic J25 ${suffix}`,
    };
    await L.clickFirst(owner, "button", "Add User");
    await owner.waitForSelector('input[placeholder="Full name"]');
    await owner.type('input[placeholder="Full name"]', member.name);
    await owner.type('input[placeholder="Username for login"]', member.username);
    await owner.type('input[placeholder="Minimum 6 characters"]', member.password);
    await owner.select(".fixed select", "agent");
    const created = await (
      await mutation(
        owner,
        "/api/admin/users",
        "POST",
        () => L.clickLast(owner, "button", "Create User"),
        201
      )
    ).json();
    await owner.waitForFunction(
      () => !document.querySelector('input[placeholder="Username for login"]')
    );
    await owner.waitForFunction(
      (name) =>
        [...document.querySelectorAll("table tbody tr")].some((r) => r.textContent.includes(name)),
      {},
      member.username
    );
    const row = () =>
      owner.evaluate(
        (name) =>
          [...document.querySelectorAll("table tbody tr")].find((r) => r.textContent.includes(name))
            .textContent,
        member.username
      );
    L.assert(
      (await row()).includes("Whole workspace"),
      "New member starts with whole-workspace access"
    );
    // Restrict to exactly one channel, no customer profiles, through the real dialog.
    await openEdit(owner, member.username);
    await L.shot(owner, "j25-access-dialog-open");
    await owner.evaluate(() => {
      const radios = [...document.querySelectorAll('input[name="access-kind"]')];
      radios[1].click();
    });
    await owner.waitForFunction(
      () => document.querySelectorAll('fieldset input[type="checkbox"]').length >= 2
    );
    await owner.evaluate(() => {
      // Grant exactly the second channel, picked by its visible label.
      const label = [...document.querySelectorAll("fieldset label")].find((l) =>
        l.textContent.includes("J25 second channel")
      );
      label.querySelector('input[type="checkbox"]').click();
    });
    await owner.evaluate(() => {
      const select = document.querySelectorAll(".fixed select")[1];
      select.value = "none";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await L.shot(owner, "j25-access-dialog-restricted");
    await mutation(
      owner,
      "/api/admin/users/" + created.id,
      "PUT",
      () => L.clickLast(owner, "button", "Save Changes"),
      200
    );
    await owner.waitForFunction(
      (name) =>
        [...document.querySelectorAll("table tbody tr")]
          .find((r) => r.textContent.includes(name))
          ?.textContent.includes("1 channel"),
      {},
      member.username
    );
    const scopeRows = L.sql(
      'SELECT string_agg("connectionId", \',\') FROM "MembershipConnectionScope" WHERE "membershipId"=' +
        quote(created.id)
    );
    L.assert(
      L.sql(
        'SELECT "scopeMode"||\'/\'||"customerProfileAccess" FROM "Membership" WHERE id=' +
          quote(created.id)
      ) === "connections/none" && scopeRows.split(",").length === 1,
      "Stored scope is connections/none with exactly one connection"
    );
    // Reopen: the dialog shows what was saved.
    await openEdit(owner, member.username);
    L.assert(
      (await owner.$$eval(
        'fieldset input[type="checkbox"]',
        (c) => c.filter((x) => x.checked).length
      )) === 1,
      "Reopened dialog pre-selects exactly the saved channel"
    );
    await L.clickLast(owner, "button", "Cancel");
    // The restricted member, logged in for real, sees only the granted channel.
    const memberBrowser = await L.launch("j25-member-" + suffix);
    browsers.push(memberBrowser);
    const page = await memberBrowser.newPage();
    const memberErrors = L.watch(page, "j25-member");
    await page.setExtraHTTPHeaders({ "X-Forwarded-For": "198.51.100.251" });
    await page.goto(L.BASE + "/login", { waitUntil: "load" });
    await page.waitForSelector("#username");
    await page.type("#username", member.username);
    await page.type("#password", member.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load" }),
      page.click('button[type="submit"]'),
    ]);
    const visible = await page.evaluate(async () => {
      const r = await fetch("/api/channels", { cache: "no-store" });
      return { status: r.status, body: r.ok ? await r.json() : null };
    });
    L.assert(visible.status === 200, "Restricted member can read their channel list");
    // The channel list pads every type with an id-less placeholder; only real connections count.
    const ids = visible.body.map((c) => c.id).filter(Boolean);
    L.assert(
      ids.length === 1 && ids[0] === scopeRows && scopeRows === other,
      "Restricted member sees exactly the granted real connection"
    );
    L.assert(!ids.includes(other), "Excluded channel is not visible to the restricted member");
    // Widen back through the UI and confirm the member's reach follows without code changes.
    await openEdit(owner, member.username);
    await owner.evaluate(() => document.querySelectorAll('input[name="access-kind"]')[0].click());
    await mutation(
      owner,
      "/api/admin/users/" + created.id,
      "PUT",
      () => L.clickLast(owner, "button", "Save Changes"),
      200
    );
    await owner.waitForFunction(
      (name) =>
        [...document.querySelectorAll("table tbody tr")]
          .find((r) => r.textContent.includes(name))
          ?.textContent.includes("Whole workspace"),
      {},
      member.username
    );
    const widened = await page.evaluate(async () =>
      (await (await fetch("/api/channels", { cache: "no-store" })).json())
        .map((c) => c.id)
        .filter(Boolean)
    );
    L.assert(
      widened.length > ids.length && widened.includes(other) && widened.includes(kept),
      "Whole-workspace scope restores the member's wider channel reach"
    );
    await L.shot(owner, "j25-access-widened");
    L.assert(
      errors.pageErrors.length === 0 && memberErrors.pageErrors.length === 0,
      "No browser runtime exceptions"
    );
    L.finish("J25-member-access-editor", {
      uiRestrictThenReopen: true,
      restrictedMemberSeesOnlyGrantedChannel: true,
      widenRestoresReach: true,
      limitations:
        "local topology/synthetic accounts; second connection is a DB prerequisite; no invitation/provider claim",
    });
  } finally {
    for (const browser of browsers.reverse()) await browser.close();
  }
})().catch((error) => {
  console.error("J25: " + error.message);
  process.exitCode = 1;
});
