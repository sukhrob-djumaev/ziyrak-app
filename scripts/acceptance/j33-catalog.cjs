// L4.1a catalog on the real UI: the super admin (B) publishes a bundle and an independent add-on (test prices), changes a new-sale
// price through a new version, and archives, with no code or deploy; published terms never change; unsupported capabilities cannot
// be offered or published; a workspace owner (A) has no path to the catalog. Nothing here collects money.
const L = require("./lib.cjs"),
  creds = require("./creds.json");
const { randomUUID } = require("node:crypto");
const suffix = randomUUID().slice(0, 8);
const bundleKey = `j33-base-${suffix}`;
const addonKey = `j33-export-${suffix}`;
const q = (v) => "'" + String(v).replaceAll("'", "''") + "'";
const call = (page, path, method, body) =>
  page.evaluate(
    async (path, method, body) => {
      const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    path, method, body
  );
async function fill(page, id, value) {
  await page.$eval(id, (el) => { el.focus(); el.select(); });
  await page.keyboard.press("Backspace");
  if (value) await page.type(id, value);
}
async function saveForm(page, label) {
  const pending = page.waitForResponse((r) => r.url().endsWith("/api/platform/catalog") && r.request().method() === "POST");
  await L.clickFirst(page, "button", label);
  const res = await pending;
  L.assert(res.status() === 200, `${label} returned 200 (${res.status()})`);
  await page.waitForFunction(() => !document.querySelector("#cat-key") || document.querySelector("#cat-key").value === "");
}
// Click an enabled button inside one item's block, after giving the required reason.
async function action(page, itemKey, label, reason) {
  await fill(page, "#cat-action-reason", reason);
  await page.waitForFunction((key, text) => [...document.querySelectorAll(`[data-item-key="${key}"] button`)].some((x) => x.innerText.trim() === text && !x.disabled), { timeout: 15000 }, itemKey, label).catch(() => undefined);
  const pending = page.waitForResponse((r) => r.url().endsWith("/api/platform/catalog") && r.request().method() === "POST");
  const clicked = await page.evaluate((key, text) => {
    const b = [...document.querySelectorAll(`[data-item-key="${key}"] button`)].find((x) => x.innerText.trim() === text && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  }, itemKey, label);
  L.assert(clicked, `${label} is available on ${itemKey}`);
  const res = await pending;
  L.assert(res.status() === 200, `${label} returned 200 (${res.status()})`);
  await page.waitForNetworkIdle({ idleTime: 300 });
}

(async () => {
  const browsers = [];
  try {
    const sb = await L.launch(creds.B.profile);
    browsers.push(sb);
    const admin = await sb.newPage();
    await admin.goto(L.BASE + "/platform/catalog", { waitUntil: "networkidle0" });
    await admin.waitForSelector("#cat-key");

    // The form can only offer implemented capabilities.
    const offered = await admin.$$eval('fieldset input[type="checkbox"]', (c) => c.map((x) => x.parentElement.innerText.trim()));
    L.assert(offered.length >= 5 && !offered.some((t) => /email|phone|alert|sms/i.test(t)), `only implemented capabilities are offered (${offered.join(" | ")})`);

    // Bundle: Web Chat. Add-on: export. Both with test prices.
    for (const [key, kind, name, cap, price] of [[bundleKey, "bundle", "J33 Inbox", "Web Chat channel", "19"], [addonKey, "addon", "J33 Export", "Workspace data export", "5"]]) {
      await fill(admin, "#cat-key", key);
      await admin.select("#cat-kind", kind);
      await fill(admin, "#cat-name", name);
      await admin.evaluate((label) => { [...document.querySelectorAll("fieldset label")].find((l) => l.innerText.trim() === label).querySelector("input").click(); }, cap);
      await fill(admin, "#cat-price", price);
      await fill(admin, "#cat-reason", "J33 create " + key);
      await saveForm(admin, "Create draft");
    }
    let rows = L.sql(`SELECT i."key"||':'||v."state"||':'||v."priceMinor" FROM "CatalogVersion" v JOIN "CatalogItem" i ON i.id=v."itemId" WHERE i."key" IN (${q(bundleKey)},${q(addonKey)}) ORDER BY i."key"`);
    L.assert(rows.includes(`${bundleKey}:draft:1900`) && rows.includes(`${addonKey}:draft:500`), "both drafts exist with their test prices");

    await action(admin, bundleKey, "Publish 1", "J33 publish bundle");
    await action(admin, addonKey, "Publish 1", "J33 publish add-on");
    rows = L.sql(`SELECT string_agg(v."state", ',') FROM "CatalogVersion" v JOIN "CatalogItem" i ON i.id=v."itemId" WHERE i."key" IN (${q(bundleKey)},${q(addonKey)})`);
    L.assert(rows === "published,published", `bundle and add-on are published independently (${rows})`);

    // Price change = new version; the published one keeps its terms.
    await action(admin, bundleKey, "New version", "J33 start price change");
    await admin.waitForFunction((key) => document.querySelector(`[data-item-key="${key}"] [data-version="2"]`), {}, bundleKey);
    await admin.evaluate((key) => { [...document.querySelectorAll(`[data-item-key="${key}"] button`)].find((b) => b.innerText.trim() === "Edit draft 2").click(); }, bundleKey);
    await admin.waitForSelector("#cat-name");
    await fill(admin, "#cat-price", "24");
    await fill(admin, "#cat-reason", "J33 raise new-sale price");
    await saveForm(admin, "Save draft");
    await action(admin, bundleKey, "Publish 2", "J33 publish new price");
    const prices = L.sql(`SELECT string_agg(v."version"||'='||v."priceMinor", ',' ORDER BY v."version") FROM "CatalogVersion" v JOIN "CatalogItem" i ON i.id=v."itemId" WHERE i."key"=${q(bundleKey)}`);
    L.assert(prices === "1=1900,2=2400", `the new price is a new version and v1 keeps its terms (${prices})`);

    // Archive the add-on; archived terms stay.
    await action(admin, addonKey, "Archive 1", "J33 archive add-on");
    await admin.waitForFunction((key) => document.querySelector(`[data-item-key="${key}"] [data-version="1"]`)?.innerText.includes("archived"), {}, addonKey);
    L.assert(L.sql(`SELECT v."priceMinor" FROM "CatalogVersion" v JOIN "CatalogItem" i ON i.id=v."itemId" WHERE i."key"=${q(addonKey)}`) === "500", "archiving keeps the add-on's terms");

    // Unsupported capability / direct tampering is refused by the server, not just hidden by the form.
    const bad = await call(admin, "/api/platform/catalog", "POST", { action: "create_item", key: `j33-bad-${suffix}`, kind: "addon", reason: "J33", terms: { name: "Bad", description: "", grants: [{ capability: "channel.email" }], priceMinor: 100, currency: "USD", interval: "month" } });
    L.assert(bad.status === 200, "an unsupported capability may be drafted");
    const draftId = bad.body.result.id;
    const pub = await call(admin, "/api/platform/catalog", "POST", { action: "publish", versionId: draftId, expectedRev: bad.body.result.rev, reason: "J33" });
    L.assert(pub.status === 400, `publishing an unsupported capability is refused (${pub.status})`);
    const direct = await call(admin, "/api/platform/catalog", "POST", { action: "archive", versionId: draftId, reason: "J33" });
    L.assert(direct.status === 409, "a draft cannot be archived");

    // Exactly one audit row per action for this run's items, each with the human reason.
    const rowsByAction = L.sql(`SELECT string_agg(action||'='||n, ',' ORDER BY action) FROM (SELECT action, count(*) n FROM "PlatformAccessAudit" WHERE action LIKE 'catalog.%' AND details->>'itemKey' IN (${q(bundleKey)},${q(addonKey)}) GROUP BY action) t`);
    L.assert(rowsByAction === "catalog.draft.new=1,catalog.draft.save=1,catalog.item.create=2,catalog.version.archive=1,catalog.version.publish=3", `one audit row per catalog action (${rowsByAction})`);
    const unreasoned = L.sql(`SELECT count(*) FROM "PlatformAccessAudit" WHERE action LIKE 'catalog.%' AND details->>'itemKey' IN (${q(bundleKey)},${q(addonKey)}) AND reason NOT LIKE 'J33%'`);
    L.assert(unreasoned === "0", "every audited catalog action carries the reason the admin typed");

    // A workspace owner has no path to the catalog.
    const ob = await L.launch(creds.A.profile);
    browsers.push(ob);
    const owner = await ob.newPage();
    await owner.goto(L.BASE + "/", { waitUntil: "networkidle0" });
    const read = await call(owner, "/api/platform/catalog", "GET");
    L.assert([401, 403].includes(read.status), `workspace owner cannot read the catalog (${read.status})`);
    const write = await call(owner, "/api/platform/catalog", "POST", { action: "create_item", key: `j33-owner-${suffix}`, kind: "bundle", reason: "x", terms: { name: "x", description: "", grants: [], priceMinor: 0, currency: "USD", interval: "month" } });
    L.assert([401, 403].includes(write.status), `workspace owner cannot write the catalog (${write.status})`);
    L.assert(L.sql(`SELECT count(*) FROM "CatalogItem" WHERE "key"=${q(`j33-owner-${suffix}`)}`) === "0", "the refused owner write changed nothing");
    await owner.goto(L.BASE + "/platform/catalog", { waitUntil: "domcontentloaded" });
    await owner.waitForFunction(() => /Access denied/i.test(document.body.innerText) || location.pathname.includes("/login"), { timeout: 30000 });
    L.assert(true, "the catalog page shows a workspace owner an explicit denial");
    L.assert(!(await L.text(owner)).includes(bundleKey), "the owner's page does not reveal catalog items");

    L.finish("J33-catalog", { items: 2, versions: 3 });
  } finally {
    for (const b of browsers.reverse()) await b.close();
  }
})().catch((e) => {
  console.error("ERR", e.message);
  process.exitCode = 1;
});
