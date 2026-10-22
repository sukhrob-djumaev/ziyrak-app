// P2 managed AI acceptance. Real signed-in sessions: the super admin (B) manages policy and
// allowance through the /platform/ai-service UI; workspace A's owner sees the customer view and is
// refused every write; chat is metered against the ledger; exhaustion stops paid work and hands off.
// Provider is the local OpenAI-compatible stand-in (no real-provider claim here; the real call is the
// separate credential-gated tests/integration/managed-ai-live.test.ts). Restores A to legacy_byok at the end.
const L = require("./lib.cjs"),
  creds = require("./creds.json");
const { randomUUID } = require("node:crypto");
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const suffix = randomUUID().slice(0, 8);
const KEY = "sk-standin-managed-" + suffix;
const call = (page, path, method, body) =>
  page.evaluate(
    async (path, method, body) => {
      const r = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    path,
    method,
    body
  );
async function setValue(page, selector, value) {
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  if (value) await page.type(selector, value);
}
async function submit(page, selector, label) {
  const pending = page.waitForResponse(
    (r) => r.url().endsWith("/api/platform/ai-service") && r.request().method() === "POST"
  );
  await page.click(selector);
  const response = await pending;
  L.assert(response.status() === 200, label + " returned 200");
  return response.json();
}
(async () => {
  const browsers = [];
  try {
    const sb = await L.launch(creds.B.profile);
    browsers.push(sb);
    const admin = await sb.newPage();
    const adminErrors = L.watch(admin, "j27-super");
    await admin.goto(L.BASE + "/platform/ai-service", { waitUntil: "networkidle0" });
    await admin.waitForSelector("#policyModel");

    // Policies: generation and embedding, key write-only.
    await setValue(admin, "#policyModel", "gpt-4o-mini");
    await setValue(admin, "#policyKey", KEY);
    await setValue(admin, "#policyReason", "J27 generation policy");
    L.assert((await submit(admin, "#savePolicy", "Generation policy")).success === true, "Generation policy saved");
    await admin.select("#policyKind", "embedding");
    await setValue(admin, "#policyModel", "text-embedding-3-small");
    await setValue(admin, "#policyKey", KEY);
    await setValue(admin, "#policyReason", "J27 embedding policy");
    L.assert((await submit(admin, "#savePolicy", "Embedding policy")).success === true, "Embedding policy saved");
    const consoleBody = await call(admin, "/api/platform/ai-service", "GET");
    L.assert(
      consoleBody.status === 200 && consoleBody.body.policies.every((p) => p.hasCredential === true),
      "Console shows the policies with a credential flag"
    );
    L.assert(!JSON.stringify(consoleBody.body).includes(KEY), "The console API never returns the key");
    L.assert(!(await L.text(admin)).includes(KEY), "The console page never shows the key");
    const stored = L.sql('SELECT "credentialRef" FROM "AiServicePolicy" WHERE active=true ORDER BY kind LIMIT 1');
    L.assert(stored && !stored.includes(KEY), "The stored credential is encrypted at rest");

    // Allowance for workspace A, through the UI.
    const aId = L.sql(
      'SELECT m."businessId" FROM "Membership" m JOIN "User" u ON u.id=m."userId" WHERE u.username=' +
        quote(creds.A.user) + " AND m.role='owner'"
    );
    L.assert(aId, "Workspace A exists");
    await admin.select("#allowanceWorkspace", aId);
    await admin.select("#allowanceMode", "managed");
    await setValue(admin, "#allowanceGen", "100000");
    await setValue(admin, "#allowanceEmb", "100000");
    await setValue(admin, "#allowanceReason", "J27 onboard workspace A");
    L.assert((await submit(admin, "#saveAllowance", "Allowance")).success === true, "Allowance saved");
    await L.shot(admin, "j27-super-admin-console");

    // Workspace A's owner: read-only customer view, no write path.
    const ob = await L.launch(creds.A.profile);
    browsers.push(ob);
    const owner = await ob.newPage();
    const ownerErrors = L.watch(owner, "j27-owner");
    await owner.goto(L.BASE + "/settings", { waitUntil: "networkidle0" });
    await L.clickFirst(owner, "button", "AI Configuration");
    await owner.waitForSelector('[data-testid="managed-ai-panel"]');
    const panel = await L.text(owner);
    L.assert(panel.includes("Managed AI service") && panel.includes("Standard assistant"), "Owner sees the managed service name");
    L.assert(panel.includes("tokens used") && panel.includes("Usage resets on"), "Owner sees usage and the reset date");
    L.assert(!panel.includes("gpt-4o-mini") && !panel.includes(KEY), "Owner never sees the model or key");
    L.assert((await owner.$('input[type="password"]')) === null, "No key input is offered");
    L.assert(
      !(await owner.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("Save")))),
      "No Save button on the managed AI tab"
    );
    await L.shot(owner, "j27-owner-managed-panel");
    for (const body of [{ aiApiKey: "sk-own-" + suffix }, { aiModel: "gpt-4" }, { aiProvider: "anthropic" }]) {
      const res = await call(owner, "/api/settings/ai", "PUT", body);
      L.assert(res.status === 403 && res.body?.error?.code === "AI_MANAGED", "Owner write is refused: " + Object.keys(body)[0]);
    }
    const view = await call(owner, "/api/settings/ai", "GET");
    L.assert(
      view.body?.managed === true && !JSON.stringify(view.body).match(/gpt-4o-mini|openai|credential|sk-/),
      "Customer API exposes only safe state"
    );
    const adminApi = await call(owner, "/api/platform/ai-service", "GET");
    L.assert([401, 403].includes(adminApi.status), "Owner cannot reach the platform AI console API");

    // Metered chat through the managed policy (stand-in provider).
    const reservationsBefore = Number(L.sql('SELECT count(*) FROM "AiUsageReservation" WHERE "businessId"=' + quote(aId)));
    const chat = await call(owner, "/api/chat", "POST", { message: "What is your refund policy?", customerContact: "j27-" + suffix });
    L.assert(chat.status === 200, "Managed chat succeeds");
    const settled = L.sql(
      'SELECT coalesce(sum("settledTokens"),0) FROM "AiUsageReservation" WHERE "businessId"=' + quote(aId) + " AND kind='generation' AND state='settled'"
    );
    L.assert(Number(settled) > 0, "The attempt settled real usage in the ledger");
    L.assert(
      L.sql('SELECT count(*) FROM "AiUsageReservation" WHERE "businessId"=' + quote(aId) + " AND state='reserved'") === "0",
      "No reservation is left open"
    );
    await owner.reload({ waitUntil: "networkidle0" });
    await L.clickFirst(owner, "button", "AI Configuration");
    await owner.waitForSelector('[data-testid="managed-ai-panel"]');
    L.assert(!(await L.text(owner)).includes("0 of 100,000 tokens used\n"), "The owner's usage view reflects the spend");

    // Exhaust the allowance via the console: paid work stops, conversation is handed to a human.
    await setValue(admin, "#allowanceGen", "1");
    await setValue(admin, "#allowanceReason", "J27 exhaust");
    await admin.select("#allowanceWorkspace", aId);
    await admin.select("#allowanceMode", "managed");
    L.assert((await submit(admin, "#saveAllowance", "Exhaust")).success === true, "Limit lowered");
    const before = L.sql('SELECT count(*) FROM "AiUsageReservation" WHERE "businessId"=' + quote(aId));
    const blocked = await call(owner, "/api/chat", "POST", { message: "Another question please", customerContact: "j27b-" + suffix });
    L.assert(blocked.status === 200, "Inbound message is still accepted when the allowance is exhausted");
    L.assert(
      L.sql('SELECT count(*) FROM "AiUsageReservation" WHERE "businessId"=' + quote(aId)) === before,
      "No paid attempt was reserved after exhaustion"
    );
    L.assert(
      L.sql(
        'SELECT count(*) FROM "Conversation" WHERE "businessId"=' + quote(aId) + " AND \"customerContact\"=" + quote("j27b-" + suffix) + " AND status='escalated'"
      ) === "1",
      "The conversation is escalated to a human"
    );
    await owner.reload({ waitUntil: "networkidle0" });
    await L.clickFirst(owner, "button", "AI Configuration");
    await owner.waitForSelector('[data-testid="managed-ai-status"]');
    L.assert((await L.text(owner)).includes("usage limit is reached"), "The owner is told the limit is reached and how it recovers");
    await L.shot(owner, "j27-owner-exhausted");

    // Another workspace is unaffected.
    const bView = await call(admin, "/api/settings/ai", "GET");
    L.assert(bView.status === 200 && bView.body?.managed === undefined, "Workspace B is unaffected");

    // Restore A to its own configuration so the shared suite state is unchanged.
    await admin.select("#allowanceWorkspace", aId);
    await admin.select("#allowanceMode", "legacy_byok");
    await setValue(admin, "#allowanceGen", "500000");
    await setValue(admin, "#allowanceReason", "J27 restore");
    L.assert((await submit(admin, "#saveAllowance", "Restore")).success === true, "A restored to its own key");
    const restored = await call(owner, "/api/settings/ai", "GET");
    L.assert(restored.body?.managed === undefined, "A sees its normal AI settings again");
    L.assert(
      L.sql('SELECT count(*) FROM "PlatformAccessAudit" WHERE action LIKE \'ai.%\' AND reason LIKE \'J27%\'') >= "5" &&
        !L.sql('SELECT string_agg(details::text, \' \') FROM "PlatformAccessAudit" WHERE action LIKE \'ai.%\'').includes(KEY),
      "Every change is audited without the key"
    );
    L.assert(
      adminErrors.pageErrors.length === 0 && ownerErrors.pageErrors.length === 0,
      "No browser runtime exceptions"
    );
    void reservationsBefore;
    L.finish("J27-managed-ai", {
      keyNeverShown: true,
      ownerWritesRefused: true,
      exhaustionStopsPaidWork: true,
      limitations: "stand-in provider; real OpenAI is covered by the separate live smoke test",
    });
  } finally {
    for (const browser of browsers.reverse()) await browser.close();
  }
})().catch((error) => {
  console.error("J27: " + error.message);
  process.exitCode = 1;
});
