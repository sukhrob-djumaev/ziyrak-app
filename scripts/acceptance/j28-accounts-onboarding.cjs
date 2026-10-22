// P3 acceptance: a brand-new owner signs up with the real wizard, confirms the emailed link, is held inactive
// until onboarding finishes (including a provider-failure/resume path), activates, resets their password
// (earlier sessions end), invites a person by email through the admin UI, rejects a wrong recipient, and an
// existing username account adopts a verified email. Production web + separate worker; platform mail is
// CAPTURED to a file (nothing is delivered); the assistant is the local stand-in provider.
const L = require("./lib.cjs"),
  creds = require("./creds.json");
const { randomUUID } = require("node:crypto");
const bcrypt = require("bcryptjs");
const quote = (v) => "'" + String(v).replaceAll("'", "''") + "'";
const suffix = randomUUID().slice(0, 8);
const C = {
  user: "j28_owner_" + suffix,
  email: `j28_owner_${suffix}@example.test`,
  pass: "Initial-" + randomUUID().slice(0, 12),
  name: "J28 Owner",
  biz: "J28 Bakery " + suffix,
};
const NEW_PASS = "Changed-" + randomUUID().slice(0, 12);
const call = (page, path, method, body) =>
  page.evaluate(
    async (path, method, body) => {
      const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    path,
    method,
    body
  );
async function clickText(p, sel, text) {
  for (const e of await p.$$(sel)) {
    if ((await e.evaluate((n) => n.innerText.trim())).includes(text)) return e.click();
  }
  throw new Error("no " + sel + " with text " + text);
}
async function login(page, user, pass) {
  await page.goto(L.BASE + "/login", { waitUntil: "networkidle0" });
  await page.type("#username", user);
  await page.type("#password", pass);
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0", timeout: 20000 }).catch(() => {}), page.click('button[type="submit"]')]);
  await L.sleep(1200);
}
const step = (page, id) => page.$eval(`li[data-step="${id}"]`, (e) => e.dataset.status).catch(() => null);

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
    // ---- 0. Platform policies exist (J27 normally leaves them; otherwise the super admin creates them) ----
    if (L.sql(`SELECT count(*) FROM "AiServicePolicy" WHERE active=true`) === "0") {
      const sa = await open(creds.B.profile, "198.51.100.230");
      await sa.p.goto(L.BASE + "/platform/ai-service", { waitUntil: "networkidle0" });
      for (const [kind, model] of [["generation", "gpt-4o-mini"], ["embedding", "text-embedding-3-small"]]) {
        const res = await call(sa.p, "/api/platform/ai-service", "POST", { action: "save_policy", kind, displayName: "Standard assistant", provider: "openai", model, apiKey: "sk-standin-j28-" + suffix, maxTokens: 400, temperature: 0.2, maxPromptTokens: 12000, maxToolDepth: 5, reason: "J28 prerequisite policy" });
        L.assert(res.status === 200, `policy ${kind} created`);
      }
    }

    // ---- 1. Brand-new owner: wizard, mail, confirmation, sign-in ----
    const owner = await open("j28-owner-" + suffix, "198.51.100.231");
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
    await vpage.setExtraHTTPHeaders({ "X-Forwarded-For": "198.51.100.232" });
    await vpage.goto(vmail.link, { waitUntil: "networkidle0" });
    await vpage.click("#confirmEmail");
    await vpage.waitForSelector("#verifyDone");
    await vpage.close();
    await login(owner.p, C.user, C.pass);
    const bizId = L.sql(`SELECT m."businessId" FROM "Membership" m JOIN "User" u ON u.id=m."userId" WHERE u.username=${quote(C.user)} AND m.role='owner'`);
    L.assert(bizId, "new workspace exists");
    L.assert(L.sql(`SELECT status FROM "WorkspaceAiAllowance" WHERE "businessId"=${quote(bizId)}`) === "active", "verification released the managed AI allowance");
    await owner.p.goto(L.BASE + "/", { waitUntil: "networkidle0" });
    await owner.p.waitForSelector("#onboardingPanel");
    L.assert(!(await owner.p.$("#verifyBanner")), "no verification banner once confirmed");
    L.assert((await owner.p.$eval("#activateWorkspace", (b) => b.disabled)) === true, "activation is disabled before the steps are done");
    await L.shot(owner.p, "j28-onboarding-start");

    // ---- 2. Inactive workspace: visitors get a neutral notice, no AI work ----
    const gated = await call(owner.p, "/api/chat", "POST", { message: "Hello, are you open?", customerContact: "j28-visitor-" + suffix });
    L.assert(gated.status === 200 && /being set up/i.test(gated.body?.response ?? ""), "before activation a visitor gets the setup notice");
    L.assert(L.sql(`SELECT count(*) FROM "AiUsageReservation" WHERE "businessId"=${quote(bizId)} AND kind='generation'`) === "0", "no AI attempt was reserved before activation");

    // ---- 3. Knowledge and channel (real APIs); panel state survives a reload ----
    const cat = await call(owner.p, "/api/knowledge/categories", "POST", { name: "General" });
    L.assert(cat.status === 201, "knowledge category created");
    const entry = await call(owner.p, "/api/knowledge/entries", "POST", { categoryId: cat.body.id, title: "Opening hours", content: "ZIYRAK-J28-CODE-4711 We open at nine and close at five." });
    L.assert(entry.status === 201, "knowledge entry created");
    const chan = await call(owner.p, "/api/channels/webchat-connections", "POST", { allowedOrigins: ["http://localhost:4020"] });
    L.assert(chan.status === 201, "web chat connection created");
    await owner.p.reload({ waitUntil: "networkidle0" });
    await owner.p.waitForSelector("#onboardingPanel");
    L.assert((await step(owner.p, "knowledge")) === "done" && (await step(owner.p, "channel")) === "done", "knowledge and channel steps are done after a reload");

    // ---- 4. Provider failure, visible and resumable ----
    L.sql(`UPDATE "WorkspaceAiAllowance" SET status='suspended' WHERE "businessId"=${quote(bizId)}`);
    await owner.p.click("#runTestReply");
    await owner.p.waitForFunction(() => document.querySelector('li[data-step="test_reply"]')?.dataset.status === "failed", { timeout: 20000 });
    const failedText = await L.text(owner.p);
    L.assert(/could not give a reply/i.test(failedText) && !/sk-|suspended|reservation|openai/i.test(failedText), "the failure is readable and exposes no provider or accounting detail");
    await owner.p.reload({ waitUntil: "networkidle0" });
    await owner.p.waitForSelector("#onboardingPanel");
    L.assert((await step(owner.p, "test_reply")) === "failed", "the failed test reply survives a reload");
    L.assert((await owner.p.$eval("#activateWorkspace", (b) => b.disabled)) === true, "activation stays blocked after a failed required step");
    await L.shot(owner.p, "j28-onboarding-failed");
    L.sql(`UPDATE "WorkspaceAiAllowance" SET status='active' WHERE "businessId"=${quote(bizId)}`);
    await owner.p.click("#runTestReply");
    await owner.p.waitForFunction(() => document.querySelector('li[data-step="test_reply"]')?.dataset.status === "done", { timeout: 30000 });
    L.assert(Number(L.sql(`SELECT coalesce(sum("settledTokens"),0) FROM "AiUsageReservation" WHERE "businessId"=${quote(bizId)} AND kind='generation' AND state='settled'`)) > 0, "the test reply settled real usage through the managed path");

    // ---- 5. Activation, then a real answer ----
    await owner.p.waitForFunction(() => !document.querySelector("#activateWorkspace")?.disabled);
    await owner.p.click("#activateWorkspace");
    await owner.p.waitForFunction(() => !document.querySelector("#onboardingPanel"), { timeout: 20000 });
    L.assert(L.sql(`SELECT "activatedAt" IS NOT NULL FROM "OnboardingState" WHERE "businessId"=${quote(bizId)}`) === "true", "activation is recorded");
    const live = await call(owner.p, "/api/chat", "POST", { message: "When do you open?", customerContact: "j28-visitor2-" + suffix });
    L.assert(live.status === 200 && !/being set up/i.test(live.body?.response ?? "") && (live.body?.response ?? "").length > 0, "after activation the assistant answers");
    await L.shot(owner.p, "j28-activated");

    // ---- 6. Password reset ends earlier sessions ----
    const other = await open("j28-owner2-" + suffix, "198.51.100.233");
    await login(other.p, C.user, C.pass);
    L.assert((await call(other.p, "/api/me", "GET")).status === 200, "a second session is signed in before the reset");
    await L.sleep(1200);
    const anon = await open("j28-anon-" + suffix, "198.51.100.234");
    const rstart = Date.now() - 1000;
    await anon.p.goto(L.BASE + "/forgot-password", { waitUntil: "networkidle0" });
    await anon.p.type("#email", C.email);
    await anon.p.click("#sendReset");
    await anon.p.waitForSelector("#forgotDone");
    const unknown = await open("j28-unknown-" + suffix, "198.51.100.235");
    await unknown.p.goto(L.BASE + "/forgot-password", { waitUntil: "networkidle0" });
    await unknown.p.type("#email", `nobody_${suffix}@example.test`);
    await unknown.p.click("#sendReset");
    await unknown.p.waitForSelector("#forgotDone");
    L.assert((await L.text(unknown.p)) === (await L.text(anon.p)), "forgot-password looks identical for an unknown address");
    const rmail = await L.waitForMail(C.email, { after: rstart, match: /reset-password/ });
    await anon.p.goto(rmail.link, { waitUntil: "networkidle0" });
    await anon.p.type("#newPassword", NEW_PASS);
    await anon.p.type("#confirmPassword", NEW_PASS);
    await anon.p.click("#setPassword");
    await anon.p.waitForSelector("#resetDone");
    L.assert((await call(other.p, "/api/me", "GET")).status === 401, "the earlier session ended after the reset");
    const replay = await call(anon.p, "/api/auth/reset-password", "POST", { token: rmail.token, password: "Third-" + suffix + "xyz" });
    L.assert(replay.status === 400, "the reset link cannot be used twice");
    const oldLogin = await call(unknown.p, "/api/auth", "POST", { action: "login", username: C.user, password: C.pass });
    L.assert(oldLogin.status === 401, "the old password no longer works");

    // ---- 7. Invitations: new person through the UI, wrong recipient, right recipient ----
    await L.sleep(1300);
    const o2 = await open("j28-owner3-" + suffix, "198.51.100.236");
    await login(o2.p, C.user, NEW_PASS);
    await o2.p.goto(L.BASE + "/admin", { waitUntil: "networkidle0" });
    const guest = { email: `j28_guest_${suffix}@example.test`, user: "j28_guest_" + suffix, pass: "Guest-" + randomUUID().slice(0, 12) };
    const istart = Date.now() - 1000;
    await L.clickFirst(o2.p, "button", "Invite User");
    await o2.p.waitForSelector("#inviteEmail");
    await o2.p.type("#inviteEmail", guest.email);
    await o2.p.select(".fixed select", "viewer");
    const posted = o2.p.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/users" && r.request().method() === "POST");
    await L.clickLast(o2.p, "button", "Send Invitation");
    L.assert((await posted).status() === 201, "the owner's invitation was accepted by the server");
    await o2.p.waitForSelector("#pendingInvitations");
    const imail = await L.waitForMail(guest.email, { after: istart, match: /accept-invitation/ });
    L.assert(/J28 Bakery/.test(imail.text), "the invitation names the workspace");
    const g = await open("j28-guest-" + suffix, "198.51.100.237");
    await g.p.goto(imail.link, { waitUntil: "networkidle0" });
    await g.p.waitForSelector("#inviteSummary");
    await g.p.type("#inviteName", "J28 Guest");
    await g.p.type("#inviteUsername", guest.user);
    await g.p.type("#invitePassword", guest.pass);
    await Promise.all([g.p.waitForNavigation({ waitUntil: "networkidle0", timeout: 20000 }).catch(() => {}), g.p.click("#acceptInvitation")]);
    await L.sleep(1000);
    L.assert(L.sql(`SELECT m.role||'|'||(u."emailVerifiedAt" IS NOT NULL) FROM "Membership" m JOIN "User" u ON u.id=m."userId" WHERE u.username=${quote(guest.user)} AND m."businessId"=${quote(bizId)}`) === "viewer|true", "the guest has the invited role and a verified address");
    L.assert((await call(g.p, "/api/admin/users", "GET")).status === 403, "the invited viewer cannot reach administration");
    const replayInvite = await call(g.p, "/api/auth/invitation/accept", "POST", { token: imail.token, username: "again_" + suffix, password: "Whatever-123456" });
    L.assert(replayInvite.status === 400, "an invitation link cannot be reused");

    // Wrong recipient: an invitation for Alice's address cannot be accepted by another signed-in account.
    const aliceEmail = `${creds.A.user}@example.test`;
    const wstart = Date.now() - 1000;
    const inv = await call(o2.p, "/api/admin/users", "POST", { email: aliceEmail, role: "viewer" });
    L.assert(inv.status === 201, "invitation for an existing account's address created");
    const amail = await L.waitForMail(aliceEmail, { after: wstart, match: /accept-invitation/ });
    const wrong = await open(creds.B.profile + "-j28", "198.51.100.238");
    await wrong.p.goto(L.BASE + "/login", { waitUntil: "networkidle0" });
    await wrong.p.type("#username", creds.B.user); await wrong.p.type("#password", creds.B.pass);
    await Promise.all([wrong.p.waitForNavigation({ waitUntil: "networkidle0", timeout: 20000 }).catch(() => {}), wrong.p.click('button[type="submit"]')]);
    const wrongTry = await call(wrong.p, "/api/auth/invitation/accept", "POST", { token: amail.token });
    L.assert(wrongTry.status === 403 && wrongTry.body?.code === "WRONG_ACCOUNT", "another account cannot accept someone else's invitation");
    const anonTry = await call(unknown.p, "/api/auth/invitation/accept", "POST", { token: amail.token });
    L.assert(anonTry.status === 401 && anonTry.body?.code === "SIGN_IN_REQUIRED", "an existing account must sign in to accept");
    L.assert(L.sql(`SELECT count(*) FROM "Membership" m JOIN "User" u ON u.id=m."userId" WHERE u.username=${quote(creds.A.user)} AND m."businessId"=${quote(bizId)}`) === "0", "nothing was granted by the refused attempts");
    const alice = await open(creds.A.profile + "-j28", "198.51.100.239");
    await alice.p.goto(L.BASE + "/login", { waitUntil: "networkidle0" });
    await alice.p.type("#username", creds.A.user); await alice.p.type("#password", creds.A.pass);
    await Promise.all([alice.p.waitForNavigation({ waitUntil: "networkidle0", timeout: 20000 }).catch(() => {}), alice.p.click('button[type="submit"]')]);
    const rightTry = await call(alice.p, "/api/auth/invitation/accept", "POST", { token: amail.token });
    L.assert(rightTry.status === 200, "the matching signed-in account accepts");
    L.assert(L.sql(`SELECT count(*) FROM "User" WHERE email=${quote(aliceEmail)}`) === "1", "no second identity was created for the existing person");
    L.assert(L.sql(`SELECT count(*) FROM "Membership" m JOIN "User" u ON u.id=m."userId" WHERE u.username=${quote(creds.A.user)}`) === "2", "the existing person now has two memberships");

    // ---- 8. An existing username account adopts a verified email ----
    const legacy = { user: "j28_legacy_" + suffix, pass: "Legacy-" + randomUUID().slice(0, 12), email: `j28_legacy_${suffix}@example.test` };
    const uid = randomUUID();
    L.sql(`INSERT INTO "User" (id,username,password,name,"updatedAt") VALUES (${[uid, legacy.user, bcrypt.hashSync(legacy.pass, 10), "J28 Legacy"].map(quote).join(",")},now())`);
    L.sql(`INSERT INTO "Membership" (id,"businessId","userId",role) VALUES (${[randomUUID(), bizId, uid, "viewer"].map(quote).join(",")})`);
    const lg = await open("j28-legacy-" + suffix, "198.51.100.240");
    await login(lg.p, legacy.user, legacy.pass);
    await lg.p.goto(L.BASE + "/", { waitUntil: "networkidle0" });
    await lg.p.waitForSelector("#accountEmailBanner");
    await L.shot(lg.p, "j28-legacy-banner");
    const lstart = Date.now() - 1000;
    await lg.p.click("#accountEmailOpen");
    await lg.p.type("#accountEmail", legacy.email);
    await lg.p.type("#accountEmailPassword", "wrong-password-1");
    await lg.p.click("#accountEmailSubmit");
    await lg.p.waitForFunction(() => document.querySelector('#accountEmailBanner [role="alert"]'));
    L.assert(L.mailMessages().every((m) => m.to !== legacy.email), "a wrong current password sends nothing");
    await lg.p.$eval("#accountEmailPassword", (e) => { e.focus(); e.select(); });
    await lg.p.keyboard.press("Backspace");
    await lg.p.type("#accountEmailPassword", legacy.pass);
    await lg.p.click("#accountEmailSubmit");
    const lmail = await L.waitForMail(legacy.email, { after: lstart, match: /verify-email/ });
    L.assert(L.sql(`SELECT email IS NULL FROM "User" WHERE username=${quote(legacy.user)}`) === "true", "nothing is stored until the new mailbox confirms");
    const lp = await lg.b.newPage();
    await lp.setExtraHTTPHeaders({ "X-Forwarded-For": "198.51.100.241" });
    await lp.goto(lmail.link, { waitUntil: "networkidle0" });
    await lp.click("#confirmEmail");
    await lp.waitForSelector("#verifyDone");
    L.assert(L.sql(`SELECT email||'|'||("emailVerifiedAt" IS NOT NULL) FROM "User" WHERE username=${quote(legacy.user)}`) === `${legacy.email}|true`, "the existing account now has a verified email");
    L.assert(
      owner.ev.pageErrors.length === 0 && o2.ev.pageErrors.length === 0 && lg.ev.pageErrors.length === 0,
      "no browser runtime exceptions"
    );
    L.assert(!JSON.stringify(L.mailMessages()).includes(NEW_PASS) && !JSON.stringify(L.mailMessages()).includes(C.pass), "no mail ever contained a password");
    L.finish("J28-accounts-onboarding", {
      signupNeverSignsIn: true,
      inactiveUntilActivated: true,
      failureVisibleAndResumable: true,
      resetEndsSessions: true,
      wrongRecipientRefused: true,
      limitations: "platform mail captured to a file (real delivery is a separate manual check); stand-in AI provider",
    });
  } finally {
    for (const b of browsers.reverse()) await b.close();
  }
})().catch((error) => {
  console.error("J28: " + error.message);
  process.exitCode = 1;
});
