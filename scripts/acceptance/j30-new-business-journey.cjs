// R4 acceptance: the complete new-business journey WITHOUT any customer AI key. A brand-new owner signs up with
// the real wizard, confirms the (captured) email, builds knowledge and a web chat channel, runs the test reply and
// activates; a customer then gets a knowledge-based managed answer, asks for a human (handoff), the owner sees
// and answers the escalated conversation, and exhausting the managed allowance hands later customers to a human
// without any paid attempt. A second workspace (A) cannot see or open any of it. Production web + separate worker;
// platform mail is CAPTURED; the model is the local stand-in (no real-provider claim; R2 carries real-model quality).
const L = require("./lib.cjs"),
  creds = require("./creds.json");
const { randomUUID } = require("node:crypto");
const quote = (v) => "'" + String(v).replaceAll("'", "''") + "'";
const suffix = randomUUID().slice(0, 8);
const ipBase = "198.51." + (100 + (parseInt(suffix.slice(0, 2), 16) % 100)) + ".";
const ip = (n) => ipBase + (10 + n);
const C = { user: "j30_owner_" + suffix, email: `j30_owner_${suffix}@example.test`, pass: "Initial-" + randomUUID().slice(0, 12), name: "J30 Owner", biz: "J30 Florist " + suffix };
const call = (page, path, method, body) =>
  page.evaluate(
    async (path, method, body) => {
      const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    path, method, body
  );
async function clickText(p, sel, text) {
  for (const e of await p.$$(sel)) if ((await e.evaluate((n) => n.innerText.trim())).includes(text)) return e.click();
  throw new Error("no " + sel + " with text " + text);
}
async function login(page, user, pass) {
  await page.goto(L.BASE + "/login", { waitUntil: "networkidle0" });
  await page.type("#username", user);
  await page.type("#password", pass);
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0", timeout: 20000 }).catch(() => {}), page.click('button[type="submit"]')]);
  await L.sleep(1200);
}
(async () => {
  const browsers = [];
  const open = async (name, ip) => {
    const b = await L.launch(name);
    browsers.push(b);
    const p = await b.newPage();
    await p.setExtraHTTPHeaders({ "X-Forwarded-For": ip });
    return { b, p, ev: L.watch(p, name) };
  };
  try {
    if (L.sql(`SELECT count(*) FROM "AiServicePolicy" WHERE active=true`) === "0") throw new Error("platform AI policies missing; run J27 first (run-all order)");
    // ---- 1. Sign up, confirm, sign in ----
    const owner = await open("j30-owner-" + suffix, ip(1));
    const before = Date.now() - 1000;
    await owner.p.goto(L.BASE + "/setup", { waitUntil: "networkidle0" });
    await owner.p.type("#name", C.name); await owner.p.type("#username", C.user); await owner.p.type("#email", C.email);
    await owner.p.type("#password", C.pass); await owner.p.type("#confirmPassword", C.pass);
    await clickText(owner.p, "button", "Next");
    await owner.p.waitForSelector("#businessName");
    await owner.p.type("#businessName", C.biz);
    await clickText(owner.p, "button", "Create Business");
    await owner.p.waitForSelector("#checkEmail");
    const vmail = await L.waitForMail(C.email, { after: before, match: /verify-email/ });
    const vpage = await owner.b.newPage();
    await vpage.setExtraHTTPHeaders({ "X-Forwarded-For": ip(2) });
    await vpage.goto(vmail.link, { waitUntil: "networkidle0" });
    await vpage.click("#confirmEmail");
    await vpage.waitForSelector("#verifyDone");
    await vpage.close();
    await login(owner.p, C.user, C.pass);
    const bizId = L.sql(`SELECT m."businessId" FROM "Membership" m JOIN "User" u ON u.id=m."userId" WHERE u.username=${quote(C.user)} AND m.role='owner'`);
    L.assert(bizId, "new workspace exists");
    // ---- 2. No customer AI key anywhere; managed allowance is the only AI path ----
    L.assert(L.sql(`SELECT count(*) FROM "BusinessConfig" WHERE "businessId"=${quote(bizId)} AND (coalesce("aiCredentialRef",'')<>'' OR coalesce("embeddingCredentialRef",'')<>'')`) === "0", "the new workspace has no customer AI credential");
    L.assert(L.sql(`SELECT mode||'|'||status FROM "WorkspaceAiAllowance" WHERE "businessId"=${quote(bizId)}`) === "managed|active", "the workspace runs on the managed allowance");
    // ---- 3. Knowledge, channel, test reply, activation ----
    await owner.p.goto(L.BASE + "/", { waitUntil: "networkidle0" });
    await owner.p.waitForSelector("#onboardingPanel");
    const cat = await call(owner.p, "/api/knowledge/categories", "POST", { name: "General" });
    L.assert(cat.status === 201, "knowledge category created");
    const entry = await call(owner.p, "/api/knowledge/entries", "POST", { categoryId: cat.body.id, title: "Opening hours", content: "ZIYRAK-J30-CODE-5521 We open at nine and close at five every weekday." });
    L.assert(entry.status === 201, "knowledge entry created");
    for (let i = 0; i < 40 && L.sql(`SELECT (metadata->'embeddingIndex') IS NOT NULL FROM "KnowledgeEntry" WHERE id=${quote(entry.body.id)}`) !== "true"; i++) await L.sleep(1000);
    L.assert(L.sql(`SELECT (metadata->'embeddingIndex') IS NOT NULL FROM "KnowledgeEntry" WHERE id=${quote(entry.body.id)}`) === "true", "the worker indexed the knowledge entry through the managed embedding allowance");
    const chan = await call(owner.p, "/api/channels/webchat-connections", "POST", { allowedOrigins: ["http://localhost:4020"] });
    L.assert(chan.status === 201, "web chat connection created");
    await owner.p.reload({ waitUntil: "networkidle0" });
    await owner.p.waitForSelector("#runTestReply");
    await owner.p.click("#runTestReply");
    await owner.p.waitForFunction(() => document.querySelector('li[data-step="test_reply"]')?.dataset.status === "done", { timeout: 40000 });
    await owner.p.waitForFunction(() => !document.querySelector("#activateWorkspace")?.disabled, { timeout: 20000 });
    await owner.p.click("#activateWorkspace");
    await owner.p.waitForFunction(() => !document.querySelector("#onboardingPanel"), { timeout: 20000 });
    L.assert(L.sql(`SELECT "activatedAt" IS NOT NULL FROM "OnboardingState" WHERE "businessId"=${quote(bizId)}`) === "true", "activation is recorded");
    // ---- 4. A customer gets a managed, knowledge-based answer ----
    const gen = () => Number(L.sql(`SELECT count(*) FROM "AiUsageReservation" WHERE "businessId"=${quote(bizId)} AND kind='generation'`));
    const g0 = gen();
    const contact1 = "j30-cust1-" + suffix;
    const a1 = await call(owner.p, "/api/chat", "POST", { message: "When do you open?", customerContact: contact1 });
    L.assert(a1.status === 200 && (a1.body?.response ?? "").length > 0 && !/being set up/i.test(a1.body.response), "after activation a customer gets an answer");
    L.assert(gen() > g0, "the answer was metered against the managed allowance");
    L.assert(L.sql(`SELECT count(*) FROM "Conversation" WHERE "businessId"=${quote(bizId)} AND "customerContact"=${quote(contact1)} AND status='escalated'`) === "0", "an ordinary supported question is not escalated");
    // ---- 5. Human handoff ----
    const contact2 = "j30-cust2-" + suffix;
    const h = await call(owner.p, "/api/chat", "POST", { message: "I want to speak to a real person about my order.", customerContact: contact2 });
    L.assert(h.status === 200, "the human request is accepted");
    const convId = L.sql(`SELECT id FROM "Conversation" WHERE "businessId"=${quote(bizId)} AND "customerContact"=${quote(contact2)} AND status='escalated'`);
    L.assert(convId, "the human request escalates the conversation");
    await owner.p.goto(L.BASE + "/conversations", { waitUntil: "networkidle0" });
    await owner.p.waitForFunction(() => document.body.innerText.includes("escalated"), { timeout: 15000 }).catch(() => {});
    await L.shot(owner.p, "j30-owner-inbox");
    L.assert(await owner.p.evaluate(() => [...document.querySelectorAll("span,div")].some((e) => e.children.length === 0 && e.innerText.trim() === "escalated")), "the owner sees the escalated conversation in the inbox");
    await L.shot(owner.p, "j30-owner-inbox");
    const reply = await call(owner.p, `/api/conversations/${convId}/messages`, "POST", { content: "Hi, this is the J30 owner; I will look at your order now." });
    L.assert(reply.status === 201, "the owner's human reply is stored");
    L.assert(L.sql(`SELECT status FROM "Conversation" WHERE id=${quote(convId)}`) === "escalated", "the conversation stays with the human");
    // ---- 6. Allowance exhaustion hands later customers to a human with no paid attempt ----
    L.sql(`UPDATE "WorkspaceAiAllowance" SET "generationLimitTokens"=1 WHERE "businessId"=${quote(bizId)}`);
    const g1 = gen();
    const contact3 = "j30-cust3-" + suffix;
    const ex = await call(owner.p, "/api/chat", "POST", { message: "Do you deliver on Sundays?", customerContact: contact3 });
    L.assert(ex.status === 200, "an inbound message is still accepted when the allowance is exhausted");
    L.assert(gen() === g1, "no paid generation was reserved after exhaustion");
    L.assert(L.sql(`SELECT count(*) FROM "Conversation" WHERE "businessId"=${quote(bizId)} AND "customerContact"=${quote(contact3)} AND status='escalated'`) === "1", "the exhausted-allowance customer is handed to a human");
    // ---- 7. A second workspace stays isolated ----
    const a = await open(creds.A.profile + "-j30-" + suffix, ip(3));
    await login(a.p, creds.A.user, creds.A.pass);
    const aBiz = L.sql(`SELECT m."businessId" FROM "Membership" m JOIN "User" u ON u.id=m."userId" JOIN "Business" b ON b.id=m."businessId" WHERE u.username=${quote(creds.A.user)} AND b.name=${quote(creds.A.biz)}`);
    L.assert(aBiz, "workspace A exists");
    L.assert((await call(a.p, "/api/workspaces", "POST", { workspaceId: bizId })).status === 403, "workspace A's owner cannot select the new workspace");
    if ((await call(a.p, "/api/me", "GET")).status !== 200) L.assert((await call(a.p, "/api/workspaces", "POST", { workspaceId: aBiz })).status === 200, "workspace A selected");
    L.assert((await call(a.p, "/api/me", "GET")).status === 200, "workspace A's owner is signed in");
    L.assert((await call(a.p, `/api/conversations/${convId}`, "GET")).status === 404, "workspace A cannot open the new workspace's conversation (got " + JSON.stringify(await call(a.p, `/api/conversations/${convId}`, "GET")).slice(0, 200) + ")");
    const list = await call(a.p, "/api/conversations", "GET");
    L.assert(!JSON.stringify(list.body).includes(`j30-cust`) && !JSON.stringify(list.body).includes("real person about my order"), "workspace A's inbox does not list the new workspace's customers");
    const kn = await call(a.p, "/api/knowledge/entries", "GET");
    L.assert(!JSON.stringify(kn.body).includes("ZIYRAK-J30-CODE-5521"), "workspace A's knowledge does not contain the new workspace's entry");
    const post = await call(a.p, `/api/conversations/${convId}/messages`, "POST", { content: "cross-tenant write attempt" });
    L.assert([403, 404].includes(post.status), "(" + JSON.stringify(post).slice(0, 200) + ") workspace A cannot write into the new workspace's conversation");
    L.assert(L.sql(`SELECT count(*) FROM "Message" WHERE "conversationId"=${quote(convId)} AND content LIKE 'cross-tenant%'`) === "0", "nothing was written by the cross-tenant attempt");
    L.assert(owner.ev.pageErrors.length === 0 && a.ev.pageErrors.length === 0, "no browser runtime exceptions");
    L.finish("J30-new-business-journey", { noCustomerAiKey: true, managedAnswer: true, humanHandoff: true, exhaustionHandsOff: true, secondWorkspaceIsolated: true, limitations: "captured mail; stand-in model" });
  } finally {
    for (const b of browsers.reverse()) await b.close();
  }
})().catch((error) => {
  console.error("J30: " + error.message);
  process.exitCode = 1;
});
