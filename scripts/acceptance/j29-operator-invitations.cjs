// After J20/J22: a super admin invites a NEW operator by email through the real UI; the invitee accepts from the
// captured link with their own username/password, the link is single-use, and the operator signs in normally.
// Synthetic accounts only; platform mail is captured to a file, nothing is delivered.
const L = require("./lib.cjs");
const creds = require("./creds.json");
const { randomUUID } = require("node:crypto");
const suffix = randomUUID().slice(0, 8);
const email = `invited.operator.${suffix}@example.test`;
const username = "invited_operator_" + suffix;
const password = "Synthetic-invitee-" + randomUUID();
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
(async () => {
  const browsers = [];
  try {
    const admin = await L.launch(creds.B.profile);
    browsers.push(admin);
    const page = await admin.newPage();
    L.watch(page, "j29-super");
    await page.goto(L.BASE + "/platform/operators", { waitUntil: "networkidle0" });
    await page.waitForSelector("#inviteOperatorEmail");
    const sentAfter = Date.now();
    await page.type("#inviteOperatorEmail", email);
    await page.type("#inviteOperatorReason", "Acceptance: invite a new operator by email");
    const pending = page.waitForResponse((r) => r.url().endsWith("/api/platform/operators") && r.request().method() === "POST");
    await page.click("#inviteOperator");
    const invite = await pending;
    L.assert(invite.status() === 200, "invite returned 200, got " + invite.status());
    const mail = await L.waitForMail(email, { after: sentAfter - 1000, match: /accept-operator-invitation/ });
    L.assert(!!mail.token, "captured invitation mail carries a link token");
    await page.waitForSelector("#operatorInvitations");
    L.assert((await page.$eval("#operatorInvitations", (e) => e.innerText)).includes(email), "pending invitation is listed for the super admin");
    L.assert(
      L.sql(`select count(*) from "User" where email=${quote(email)};`) === "0",
      "no account exists before acceptance"
    );

    // ---- Invitee: link opens, accept creates the operator; nobody is signed in by it ----
    const guest = await L.launch("j29-invitee-" + suffix);
    browsers.push(guest);
    const gp = await guest.newPage();
    await gp.setExtraHTTPHeaders({ "X-Forwarded-For": "198.51.100.77" });
    await gp.goto(mail.link, { waitUntil: "networkidle0" });
    await gp.waitForSelector("#operatorInviteUsername");
    L.assert((await L.text(gp)).includes(email), "accept page shows only the invited address");
    await gp.type("#operatorInviteName", "Invited Operator");
    await gp.type("#operatorInviteUsername", username);
    await gp.type("#operatorInvitePassword", password);
    const accepted = gp.waitForResponse((r) => r.url().includes("/api/auth/operator-invitation/accept"));
    await gp.click("#acceptOperatorInvitation");
    const response = await accepted;
    L.assert(response.status() === 200, "accept returned 200, got " + response.status());
    L.assert(!response.headers()["set-cookie"], "accept sets no session cookie");
    await gp.waitForSelector("#operatorInviteDone");
    L.assert(
      L.sql(`select count(*) from "User" where email=${quote(email)} and username=${quote(username)} and "platformRole"='operator' and "emailVerifiedAt" is not null;`) === "1",
      "operator exists, verified, with platformRole operator"
    );
    L.assert(
      L.sql(`select count(*) from "PlatformAccessAudit" where action='operator.invite' and details->>'email'=${quote(email)};`) === "1",
      "invite is audited"
    );
    L.assert(
      L.sql(`select count(*) from "PlatformAccessAudit" where action='operator.invitation.accept' and details->>'targetUserId' in (select id from "User" where username=${quote(username)});`) === "1",
      "acceptance is audited"
    );

    // ---- Single use: the same link is now a generic dead link ----
    const replay = await guest.newPage();
    await replay.goto(mail.link, { waitUntil: "networkidle0" });
    await replay.waitForSelector("#operatorInviteInvalid");
    L.assert(!(await L.text(replay)).includes(email), "a used link reveals nothing about the address");

    // ---- The operator signs in the normal way ----
    const op = await L.launch("j29-operator-" + suffix);
    browsers.push(op);
    const opPage = await op.newPage();
    await opPage.setExtraHTTPHeaders({ "X-Forwarded-For": "198.51.100.78" });
    await opPage.goto(L.BASE + "/login", { waitUntil: "networkidle0" });
    await opPage.type("#username", username);
    await opPage.type("#password", password);
    await Promise.all([opPage.waitForNavigation({ waitUntil: "networkidle0", timeout: 20000 }).catch(() => {}), opPage.click('button[type="submit"]')]);
    await L.sleep(1200);
    // An operator has no workspace, so /api/me asks for a selection (409); the platform entry endpoint is the probe.
    const entry = await opPage.evaluate(async () => (await fetch("/api/platform/enrollment")).json());
    L.assert(entry.role === "operator", "invited operator signs in with the operator role, got " + JSON.stringify(entry.role));

    // ---- An address that now belongs to an account cannot be invited again ----
    const again = await page.evaluate(
      async (address) =>
        (
          await fetch("/api/platform/operators", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "invite", email: address, reason: "Acceptance: duplicate" }),
          })
        ).status,
      email
    );
    L.assert(again === 409, "inviting an existing account's address is refused with 409, got " + again);

    L.finish("J29-operator-invitations", {
      checks:
        "real UI invite, captured mail, accept page, no session on accept, audits, single-use link, normal sign-in, existing-address refusal",
      limitations: "synthetic address; platform mail captured to a file, no real delivery",
    });
  } finally {
    for (const b of browsers.reverse()) await b.close();
  }
})().catch((error) => {
  console.error("ERR", error.message);
  process.exitCode = 1;
});
