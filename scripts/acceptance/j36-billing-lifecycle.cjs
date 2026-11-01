// L5 payment lifecycle on the real UI against the local Stripe stand-in (test-mode key shape, nothing reaches Stripe): the super admin
// publishes a bundle and the price syncs to the provider; a fresh owner reviews the price and goes to checkout; the redirect alone
// grants nothing; paying makes the confirmed subscription appear; duplicate and held/reversed events leave one correct subscription;
// a failed payment shows the grace note and a paid invoice recovers; cancel-at-period-end shows as canceling; the webhook refuses a bad
// signature; an anonymous caller and another workspace cannot read this workspace's billing; the return page fits a phone.
const L = require("./lib.cjs"),
  creds = require("./creds.json");
const { randomUUID } = require("node:crypto");
const suffix = randomUUID().slice(0, 8);
const bundleKey = `j36-base-${suffix}`;
const STAND = "http://127.0.0.1:4030";
const q = (v) => "'" + String(v).replaceAll("'", "''") + "'";
const call = (page, path, method, body, headers) =>
  page.evaluate(
    async (path, method, body, headers) => {
      const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json", ...headers } : headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    path, method, body, headers || {}
  );
const control = async (path, body) => (await fetch(`${STAND}/__control/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })).json();
async function until(fn, what, ms = 45000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await L.sleep(500);
  }
}

(async () => {
  const browsers = [];
  try {
    // 1. Super admin publishes a bundle; the price sync job creates the provider price.
    const sb = await L.launch(creds.B.profile);
    browsers.push(sb);
    const admin = await sb.newPage();
    await admin.goto(L.BASE + "/platform/catalog", { waitUntil: "networkidle0" });
    await L.allowUsd(admin);
    const created = await call(admin, "/api/platform/catalog", "POST", { action: "create_item", key: bundleKey, kind: "bundle", reason: "J36 create", terms: { name: "J36 Inbox", description: "J36 test package", grants: [{ capability: "channel.webchat" }], priceMinor: 1900, currency: "USD", interval: "month" } });
    L.assert(created.status === 200, `the bundle draft is created (${created.status})`);
    const pub = await call(admin, "/api/platform/catalog", "POST", { action: "publish", versionId: created.body.result.id, expectedRev: created.body.result.rev, reason: "J36 publish" });
    L.assert(pub.status === 200, `the bundle is published (${pub.status})`);
    const versionId = created.body.result.id;
    await until(() => L.sql(`SELECT count(*) FROM "ProviderPriceRef" WHERE "versionId"=${q(versionId)} AND state='synced'`) === "1", "the price to sync to the provider");
    L.assert(true, "the published price synced to the provider without a deploy");

    // 2. A fresh owner reviews the price and starts checkout.
    const ob = await L.launch("j36-owner-" + suffix);
    browsers.push(ob);
    const owner = await ob.newPage();
    await owner.goto(L.BASE + "/login", { waitUntil: "networkidle0" });
    const email = `j36-${suffix}@example.test`;
    const mailFrom = Date.now() - 1000;
    const su = await call(owner, "/api/auth", "POST", { action: "signup", businessName: `J36 Co ${suffix}`, username: `j36-${suffix}`, email, password: "J36-password-ok-1", name: "J36" }, { "X-Forwarded-For": `198.51.100.${100 + Math.floor(Math.random() * 50)}` });
    L.assert(su.status === 202, `the owner signs up (${su.status})`);
    const vmail = await L.waitForMail(email, { after: mailFrom, match: /verify-email/ });
    await owner.goto(vmail.link, { waitUntil: "networkidle0" });
    await owner.click("#confirmEmail");
    await owner.waitForSelector("#verifyDone");
    await owner.goto(L.BASE + "/login", { waitUntil: "networkidle0" });
    await owner.type("#username", "j36-" + suffix);
    await owner.type("#password", "J36-password-ok-1");
    await Promise.all([owner.waitForNavigation({ waitUntil: "networkidle0", timeout: 20000 }).catch(() => {}), owner.click('button[type="submit"]')]);
    await L.sleep(1200);
    const biz = L.sql(`SELECT m."businessId" FROM "Membership" m JOIN "User" u ON u.id=m."userId" WHERE m.role='owner' AND u.username=${q("j36-" + suffix)}`);
    const subs = () => L.sql(`SELECT coalesce(string_agg(status, ',' ORDER BY "createdAt"), '') FROM "BillingSubscription" WHERE "businessId"=${q(biz)}`);

    await owner.goto(L.BASE + "/billing", { waitUntil: "networkidle0" });
    await owner.waitForSelector('[data-testid="sellable"]');
    const offered = await owner.$eval('[data-testid="sellable"]', (el) => el.innerText);
    L.assert(offered.includes("J36 Inbox"), "the published bundle is offered to the owner");
    await owner.evaluate(() => { [...document.querySelectorAll('[data-testid="sellable"] li')].find((l) => l.innerText.includes("J36 Inbox")).querySelector("input[type=checkbox]").click(); });
    await owner.click('[data-testid="get-quote"]');
    await owner.waitForSelector('[data-testid="quote"]');
    L.assert((await owner.$eval('[data-testid="quote"]', (el) => el.innerText)).includes("19.00 USD"), "the quote shows the server-priced total");
    await Promise.all([owner.waitForNavigation({ waitUntil: "domcontentloaded" }), owner.click('[data-testid="start-checkout"]')]);
    L.assert(owner.url().startsWith(STAND + "/pay/"), `checkout leaves for the payment partner (${owner.url()})`);
    L.assert(subs() === "", "going to checkout grants nothing");

    // 3. Pay; the confirmed subscription appears and the return page waits for it.
    await Promise.all([owner.waitForNavigation({ waitUntil: "domcontentloaded" }), owner.click("#pay")]);
    L.assert(owner.url().includes("/billing?checkout=return"), `the owner returns to billing (${owner.url()})`);
    await until(() => subs() === "active", "the subscription to be confirmed by the webhook");
    await owner.goto(L.BASE + "/billing", { waitUntil: "networkidle0" });
    await owner.waitForSelector('[data-testid="sub-state"]');
    L.assert(/active/i.test(await owner.$eval('[data-testid="sub-state"]', (el) => el.innerText)), "the owner sees an active subscription");
    const subRef = L.sql(`SELECT "subscriptionRef" FROM "BillingSubscription" WHERE "businessId"=${q(biz)}`);

    // 4. Duplicate delivery, then held and reversed delivery: still one subscription, correct state.
    await control("config", { mode: "duplicate" });
    await control(`subscriptions/${subRef}/invoice`, { paid: true });
    await control("config", { mode: "hold" });
    await control(`subscriptions/${subRef}/invoice`, { paid: false });
    await control(`subscriptions/${subRef}/invoice`, { paid: true });
    await control("config", { mode: "normal" });
    await control("flush", { reverse: true });
    await L.sleep(3000);
    L.assert(subs() === "active", `duplicate and reordered events leave one active subscription (${subs()})`);

    // 5. Failed payment shows the grace note; a paid invoice recovers.
    await control(`subscriptions/${subRef}/invoice`, { paid: false });
    await until(() => subs() === "past_due", "the failed payment to be recorded");
    L.assert(L.sql(`SELECT "graceEndsAt" IS NOT NULL FROM "BillingSubscription" WHERE "businessId"=${q(biz)}`) === "true", "a failed payment starts a grace period");
    await owner.goto(L.BASE + "/billing", { waitUntil: "networkidle0" });
    await owner.waitForSelector('[data-testid="sub-state"]');
    L.assert(/payment method/i.test(await owner.$eval('[data-testid="sub-state"]', (el) => el.innerText)), "the owner sees the grace note");
    await control(`subscriptions/${subRef}/invoice`, { paid: true });
    await until(() => subs() === "active", "the payment to recover");
    L.assert(L.sql(`SELECT "graceEndsAt" IS NULL FROM "BillingSubscription" WHERE "businessId"=${q(biz)}`) === "true", "recovery clears the grace period");

    // 6. Cancel at period end (done at the provider, as the portal would) shows as canceling and stays usable.
    const cancel = await fetch(`${STAND}/v1/subscriptions/${subRef}`, { method: "POST", headers: { Authorization: "Bearer sk_test_acceptance", "Content-Type": "application/x-www-form-urlencoded" }, body: "cancel_at_period_end=true" });
    L.assert(cancel.status === 200, "the provider records cancel at period end");
    await until(() => subs() === "canceling", "the cancellation to be recorded");
    await owner.goto(L.BASE + "/billing", { waitUntil: "networkidle0" });
    L.assert(!(await owner.$('[data-testid="hold-note"]')), "a canceling subscription is not held");

    // 7. Boundaries: bad signature, anonymous, and another workspace.
    const anon = await sb.newPage();
    await anon.goto(L.BASE + "/login", { waitUntil: "domcontentloaded" });
    const bad = await anon.evaluate(async () => { const r = await fetch("/api/billing/webhook", { method: "POST", headers: { "Stripe-Signature": "t=1,v1=00", "Content-Type": "application/json" }, body: "{}" }); return r.status; });
    L.assert(bad === 400, `a webhook with a bad signature is refused (${bad})`);
    const other = await call(admin, "/api/billing/status", "GET");
    L.assert(!JSON.stringify(other.body).includes(subRef), "another workspace's billing view never contains this subscription");
    const fresh = await ob.createBrowserContext();
    const anonPage = await fresh.newPage();
    await anonPage.goto(L.BASE + "/login", { waitUntil: "domcontentloaded" });
    const anonStatus = await call(anonPage, "/api/billing/status", "GET");
    L.assert(anonStatus.status === 401, `an anonymous caller cannot read billing (${anonStatus.status})`);
    const anonCheckout = await call(anonPage, "/api/billing/checkout", "POST", { lines: [{ versionId, quantity: 1 }], quoteHash: "0".repeat(64), quotedAt: new Date().toISOString() });
    L.assert([401, 403].includes(anonCheckout.status), `an anonymous caller cannot start checkout (${anonCheckout.status})`);

    // 8. Phone width: the billing page does not scroll sideways.
    await owner.setViewport({ width: 390, height: 800 });
    await owner.goto(L.BASE + "/billing?checkout=return", { waitUntil: "networkidle0" });
    const overflow = await owner.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    L.assert(overflow <= 1, `the billing page fits a phone (${overflow}px over)`);

    L.finish("J36-billing-lifecycle", { subscription: subRef });
  } finally {
    for (const b of browsers.reverse()) await b.close();
  }
})().catch((e) => {
  console.error("ERR", e.message);
  process.exitCode = 1;
});
