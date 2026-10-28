// L4.1b on the real UI: the super admin (B) builds a small bundle and assigns it to workspace A through the console; A's owner
// sees exactly that package on Plan & usage, a feature outside it is refused by the server and explained in the page, and
// assigning the baseline back restores access at once. Other roles never see the billing view. Nothing here collects money.
const L = require("./lib.cjs"),
  creds = require("./creds.json");
const { randomUUID } = require("node:crypto");
const suffix = randomUUID().slice(0, 8);
const key = `j34-chat-${suffix}`;
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

// Leave workspace A on the explicit baseline package whatever happened (other journeys depend on its access).
function restoreBaseline(aId) {
  if (!aId) return;
  L.sql(`UPDATE "WorkspacePurchase" SET "state"='ended', "endsAt"=now() WHERE "businessId"=${q(aId)} AND "state"='active' AND "source"<>'baseline'`);
  L.sql(`INSERT INTO "WorkspacePurchase" ("id","businessId","versionId","quantity","source","state","reason") SELECT gen_random_uuid()::text, ${q(aId)}, v."id", 1, 'baseline', 'active', 'J34 restore' FROM "CatalogVersion" v JOIN "CatalogItem" i ON i."id"=v."itemId" WHERE i."key"='legacy-baseline' AND v."version"=1 AND NOT EXISTS (SELECT 1 FROM "WorkspacePurchase" p WHERE p."businessId"=${q(aId)} AND p."state"='active' AND p."source"='baseline')`);
}
(async () => {
  const browsers = [];
  let aId;
  try {
    const sb = await L.launch(creds.B.profile);
    browsers.push(sb);
    const admin = await sb.newPage();
    await admin.goto(L.BASE + "/platform/catalog", { waitUntil: "networkidle0" });
    await admin.waitForSelector("#cat-key");

    // Build and publish a bundle that includes Web Chat only.
    const created = await call(admin, "/api/platform/catalog", "POST", { action: "create_item", key, kind: "bundle", reason: "J34 chat only", terms: { name: "J34 Chat only", description: "", grants: [{ capability: "channel.webchat" }, { capability: "seats.members", amount: 50 }], priceMinor: 900, currency: "USD", interval: "month" } });
    L.assert(created.status === 200, "bundle drafted");
    const published = await call(admin, "/api/platform/catalog", "POST", { action: "publish", versionId: created.body.result.id, expectedRev: created.body.result.rev, reason: "J34 publish" });
    L.assert(published.status === 200, "bundle published");

    // Assign it to workspace A through the console, replacing A's baseline.
    aId = (await call(admin, "/api/platform/catalog", "GET")).body.workspaces.find((w) => w.name === creds.A.biz)?.id;
    L.assert(aId, "workspace A is listed in the console");
    await admin.reload({ waitUntil: "networkidle0" });
    await admin.select("#ws-select", aId);
    await admin.select("#ws-version", published.body.result.id);
    await admin.evaluate(() => [...document.querySelectorAll("label")].find((l) => l.innerText.includes("Replace the workspace"))?.querySelector("input").click());
    await fill(admin, "#ws-reason", `J34 ${suffix} move A to the chat-only package`);
    const pending = admin.waitForResponse((r) => r.url().endsWith("/api/platform/catalog") && r.request().method() === "POST");
    await L.clickFirst(admin, "button", "Assign version");
    L.assert((await pending).status() === 200, "assignment through the console returned 200");
    const held = L.sql(`SELECT string_agg(i."key", ',') FROM "WorkspacePurchase" p JOIN "CatalogVersion" v ON v.id=p."versionId" JOIN "CatalogItem" i ON i.id=v."itemId" WHERE p."businessId"=${q(aId)} AND p."state"='active'`);
    L.assert(held === key, `A holds exactly the new bundle (${held})`);

    // A's owner sees the package and the refusal.
    const ob = await L.launch(creds.A.profile);
    browsers.push(ob);
    const owner = await ob.newPage();
    await owner.goto(L.BASE + "/billing", { waitUntil: "networkidle0" });
    await owner.waitForSelector('[data-testid="billing-view"] [data-testid="purchase"]');
    const text = await L.text(owner);
    L.assert(text.includes("J34 Chat only"), "Plan & usage names the package");
    const exportRow = await owner.$eval('[data-capability="data.export"]', (e) => e.innerText);
    const chatRow = await owner.$eval('[data-capability="channel.webchat"]', (e) => e.innerText);
    L.assert(/Not included/.test(exportRow) && /Included/.test(chatRow), `capabilities match the package (export: ${exportRow.replace(/\s+/g, " ")}; chat: ${chatRow.replace(/\s+/g, " ")})`);
    L.assert(/of 50 seats/.test(await owner.$eval('[data-testid="seat-usage"]', (e) => e.innerText)), "seat limit shown");
    const links = await owner.$$eval("nav a", (a) => a.map((x) => new URL(x.href).pathname));
    L.assert(links.includes("/billing"), "the owner's menu has Plan & usage");

    const refused = await call(owner, "/api/export?type=conversations&format=json", "GET");
    L.assert(refused.status === 403 && refused.body.error.code === "ENTITLEMENT_REQUIRED", `export is refused by the server (${refused.status})`);
    const hook = await call(owner, "/api/webhooks", "POST", { name: "j34", url: "https://example.com/h", triggerOn: "conversation.created" });
    L.assert(hook.status === 403 && hook.body.error.code === "ENTITLEMENT_REQUIRED", `webhooks are refused by the server (${hook.status})`);
    // The Webhooks page tells the person why, and keeps what they typed.
    await owner.goto(L.BASE + "/webhooks", { waitUntil: "networkidle0" });
    await L.clickFirst(owner, "button", "Add Webhook");
    await owner.waitForSelector('input[placeholder="Slack Notification"]');
    await owner.type('input[placeholder="Slack Notification"]', "Blocked hook");
    await owner.type('input[type="url"], input[placeholder^="https"]', "https://example.com/hook");
    await L.clickLast(owner, "button", "Create Webhook");
    await owner.waitForSelector('[role="alert"]');
    L.assert(/package does not include/i.test(await owner.$eval('[role="alert"]', (e) => e.innerText)), "the page explains the package limit");
    L.assert((await owner.$eval('input[placeholder="Slack Notification"]', (e) => e.value)) === "Blocked hook", "the form keeps what was typed");

    // Assigning the baseline back restores access immediately.
    const baselineId = L.sql(`SELECT v.id FROM "CatalogVersion" v JOIN "CatalogItem" i ON i.id=v."itemId" WHERE i."key"='legacy-baseline' AND v."version"=1`);
    const back = await call(admin, "/api/platform/catalog", "POST", { action: "assign_version", businessId: aId, versionId: baselineId, replaceBundle: true, reason: `J34 ${suffix} restore baseline` });
    L.assert(back.status === 200, "baseline assigned back");
    const ok = await call(owner, "/api/export?type=conversations&format=json", "GET");
    L.assert(ok.status === 200, `export works again at once (${ok.status})`);

    // Exactly one audit row per entitlement action for this run.
    const rows = L.sql(`SELECT string_agg(action||'='||n, ',' ORDER BY action) FROM (SELECT action, count(*) n FROM "PlatformAccessAudit" WHERE action LIKE 'entitlement.%' AND "workspaceId"=${q(aId)} AND reason LIKE 'J34 ${suffix}%' GROUP BY action) t`);
    L.assert(rows === "entitlement.assign=2", `one audit row per assignment (${rows})`);

    restoreBaseline(aId);
    L.finish("J34-package-entitlements", { bundle: key });
  } finally {
    restoreBaseline(aId);
    for (const b of browsers.reverse()) await b.close();
  }
})().catch((e) => {
  console.error("ERR", e.message);
  process.exitCode = 1;
});
